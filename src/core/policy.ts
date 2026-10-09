import { DEFAULTS, REASON, VERDICT, type Reason, type Verdict } from "./constants.ts"

/** A hex address as viem types it. */
export type Address = `0x${string}`

/**
 * The rules a principal grants an agent. Stored as the mandate's public JSON payload, so a
 * counterparty can check an action against it without asking anyone. Amounts are integers in
 * minor units (kopecks for RUB, cents for USD) to stay exact.
 */
export interface Policy {
  v: 1
  /** Human-readable purpose. Synthetic text only: no names, phone numbers or e-mails. */
  purpose: string
  /** ISO 4217 code or token symbol. */
  currency: string
  /** Minor units per major unit as a power of ten (2 for RUB and USD). */
  decimals: number
  /** Maximum amount of one action, in minor units. */
  perActionCap: bigint
  /** Maximum sum of allowed actions in one policy day, in minor units. */
  perDayCap: bigint
  /** Action kinds the agent may perform, for example `fuel` or `toll`. */
  kinds: string[]
  /** Optional allowlist of counterparty wallets. Empty or absent means any counterparty. */
  counterparties?: Address[]
  /** The policy day starts at local midnight; this is the local offset from UTC in minutes. */
  dayOffsetMinutes: number
  /** How long the mandate lives without a heartbeat. */
  leaseSeconds: number
  /** How long records made under this mandate are kept (the dispute window). */
  retentionDays: number
}

/** What the agent wants to do. `details` never leaves the device unencrypted. */
export interface ActionRequest {
  kind: string
  amount: bigint
  counterparty?: Address
  /** Wall-clock time of the attempt, in milliseconds since the Unix epoch. */
  tsMs: number
  details: Record<string, unknown>
}

/** Facts the agent runtime reads from Arkiv right before it decides. */
export interface DecisionContext {
  /** The mandate exists and has not expired or been revoked. */
  mandateLive: boolean
  /** The mandate names this agent's wallet. */
  agentMatches: boolean
  /** Sum of allowed actions under this mandate in the current policy day, in minor units. */
  spentToday: bigint
}

export interface Decision {
  verdict: Verdict
  reason: Reason
}

const KIND_RE = /^[a-z][a-z0-9_.-]{0,31}$/

/** Decide one action. Pure: the same inputs always give the same verdict. */
export function evaluate(policy: Policy, ctx: DecisionContext, req: ActionRequest): Decision {
  const refuse = (reason: Reason): Decision => ({ verdict: VERDICT.refused, reason })
  if (!ctx.mandateLive) return refuse(REASON.noLiveMandate)
  if (!ctx.agentMatches) return refuse(REASON.wrongAgent)
  if (req.amount <= 0n) return refuse(REASON.invalidAmount)
  if (!policy.kinds.includes(req.kind)) return refuse(REASON.kindNotAllowed)
  const allow = policy.counterparties ?? []
  if (allow.length > 0) {
    const cp = req.counterparty?.toLowerCase()
    if (!cp || !allow.some((a) => a.toLowerCase() === cp)) return refuse(REASON.counterpartyNotAllowed)
  }
  if (req.amount > policy.perActionCap) return refuse(REASON.overActionCap)
  if (ctx.spentToday + req.amount > policy.perDayCap) return refuse(REASON.overDayCap)
  return { verdict: VERDICT.allowed, reason: REASON.ok }
}

/** Start (inclusive) and end (exclusive) of the policy day that contains `tsMs`, in ms since epoch. */
export function dayWindow(tsMs: number, dayOffsetMinutes: number): { startMs: number; endMs: number } {
  const offsetMs = dayOffsetMinutes * 60_000
  const day = 86_400_000
  const startMs = Math.floor((tsMs + offsetMs) / day) * day - offsetMs
  return { startMs, endMs: startMs + day }
}

/** Serialise a policy to the JSON stored in the mandate payload (bigints become decimal strings). */
export function policyToJson(policy: Policy): Record<string, unknown> {
  return {
    ...policy,
    perActionCap: policy.perActionCap.toString(),
    perDayCap: policy.perDayCap.toString(),
  }
}

export class PolicyError extends Error {
  override name = "PolicyError"
}

function asInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new PolicyError(`policy.${field} must be an integer in [${min}, ${max}]`)
  }
  return value
}

function asAmount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) {
    throw new PolicyError(`policy.${field} must be a decimal string of minor units`)
  }
  return BigInt(value)
}

/**
 * Parse and validate a mandate payload. Payloads are public and anyone can write a mandate, so
 * nothing in them is trusted until this passes; who wrote the mandate is checked separately with
 * `$creator`.
 */
export function parsePolicy(raw: unknown): Policy {
  if (typeof raw !== "object" || raw === null) throw new PolicyError("policy must be a JSON object")
  const r = raw as Record<string, unknown>
  if (r.v !== 1) throw new PolicyError("unsupported policy version")
  if (typeof r.purpose !== "string" || r.purpose.length > 280) throw new PolicyError("policy.purpose must be a string of at most 280 characters")
  if (typeof r.currency !== "string" || !/^[A-Z0-9]{2,10}$/.test(r.currency)) throw new PolicyError("policy.currency must be an upper-case code")
  if (!Array.isArray(r.kinds) || r.kinds.length === 0 || r.kinds.length > 16 || !r.kinds.every((k) => typeof k === "string" && KIND_RE.test(k))) {
    throw new PolicyError("policy.kinds must list 1 to 16 lower-case kinds")
  }
  let counterparties: Address[] | undefined
  if (r.counterparties !== undefined) {
    if (!Array.isArray(r.counterparties) || !r.counterparties.every((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))) {
      throw new PolicyError("policy.counterparties must be a list of addresses")
    }
    counterparties = r.counterparties as Address[]
  }
  const policy: Policy = {
    v: 1,
    purpose: r.purpose,
    currency: r.currency,
    decimals: asInt(r.decimals, "decimals", 0, 18),
    perActionCap: asAmount(r.perActionCap, "perActionCap"),
    perDayCap: asAmount(r.perDayCap, "perDayCap"),
    kinds: [...(r.kinds as string[])],
    dayOffsetMinutes: asInt(r.dayOffsetMinutes, "dayOffsetMinutes", -720, 840),
    leaseSeconds: asInt(r.leaseSeconds, "leaseSeconds", 30, 7 * 86_400),
    retentionDays: asInt(r.retentionDays, "retentionDays", 1, 730),
  }
  if (counterparties) policy.counterparties = counterparties
  if (policy.leaseSeconds % 2 !== 0) throw new PolicyError("policy.leaseSeconds must be a whole number of 2-second blocks")
  if (policy.perActionCap > policy.perDayCap) throw new PolicyError("policy.perActionCap cannot exceed perDayCap")
  return policy
}

/** The policy the demo fleet uses: fuel and tolls, 15 000 RUB per action, 40 000 RUB per day. */
export function demoPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    v: 1,
    purpose: "Fleet card for the dispatcher agent of a 12-truck haulier (synthetic demo): fuel and road tolls only.",
    currency: "RUB",
    decimals: 2,
    perActionCap: 1_500_000n,
    perDayCap: 4_000_000n,
    kinds: ["fuel", "toll"],
    dayOffsetMinutes: DEFAULTS.dayOffsetMinutes,
    leaseSeconds: DEFAULTS.leaseSeconds,
    retentionDays: DEFAULTS.retentionDays,
    ...overrides,
  }
}

/** Format minor units for people: 1250000n with 2 decimals → "12 500.00". */
export function formatAmount(minor: bigint, decimals: number): string {
  const neg = minor < 0n
  const abs = neg ? -minor : minor
  const base = 10n ** BigInt(decimals)
  const whole = (abs / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  const frac = decimals > 0 ? "." + (abs % base).toString().padStart(decimals, "0") : ""
  return (neg ? "-" : "") + whole + frac
}
