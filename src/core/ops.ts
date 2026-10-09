import { DEFAULTS, REASON, VERDICT } from "./constants.ts"
import { ackBatch, heartbeat, mandateCreate, parseMandate, parseRecord, recordBatch, sameAddr, type Hex, type Mandate, type RecordFields } from "./entities.ts"
import { dayWindow, evaluate, type ActionRequest, type Address, type Decision, type Policy } from "./policy.ts"
import { spentSince } from "./queries.ts"
import type { TachoReader } from "./reader.ts"
import { verifyRecord, type VerifyReport } from "./verify.ts"
import type { TachoWriter } from "./writer.ts"

// ---------------------------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------------------------

export async function issueMandate(principal: TachoWriter, agent: Address, policy: Policy, now = Date.now()) {
  const r = await principal.createEntity(mandateCreate({ agent, policy, issuedMs: now }))
  return { mandateKey: r.entityKey, txHash: r.txHash, expiresAt: r.expiresAt }
}

/** Renew the lease. Only the owner (the principal) can: the mandate has no permissionless extension. */
export async function renewMandate(principal: TachoWriter, mandateKey: Hex, leaseSeconds: number) {
  return principal.extendEntity(heartbeat(mandateKey, leaseSeconds))
}

/** Revoke at once. An agent watching over WebSocket stops on the EntityDeleted event. */
export async function revokeMandate(principal: TachoWriter, mandateKey: Hex) {
  return principal.deleteEntity({ entityKey: mandateKey })
}

// ---------------------------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------------------------

export interface AgentConfig {
  reader: TachoReader
  writer: TachoWriter
  mandateKey: Hex
  /** The principal this agent works for. A mandate from anyone else is ignored. */
  principal: Address
  dataKey: string
  now?: () => number
  /** How long to wait for a fresh record to become queryable before the next decision. */
  visibilityTimeoutMs?: number
}

export interface AttemptResult {
  decision: Decision
  fields: RecordFields
  recordKey: Hex
  txHash: Hex
  mandate: Mandate | null
  spentBefore: bigint
}

/** Read the mandate right before deciding. Absent, expired, revoked or foreign means no authority. */
export async function loadMandate(reader: TachoReader, mandateKey: Hex, principal: Address): Promise<Mandate | null> {
  const e = await reader.getEntity(mandateKey)
  if (!e) return null
  try {
    const m = parseMandate(e)
    return sameAddr(m.principal, principal) ? m : null
  } catch {
    return null
  }
}

/** Sum of allowed amounts under the mandate since the start of the policy day, from Arkiv. */
export async function spentToday(reader: TachoReader, mandate: Mandate, nowMs: number): Promise<bigint> {
  const { startMs } = dayWindow(nowMs, mandate.policy.dayOffsetMinutes)
  const rows = await reader.find(spentSince(mandate.key, mandate.agent, startMs))
  let sum = 0n
  for (const e of rows) {
    try {
      const r = parseRecord(e)
      if (sameAddr(r.writer, mandate.agent)) sum += r.amount
    } catch {
      /* not a record we wrote; ignore */
    }
  }
  return sum
}

/**
 * One attempt by the agent: read the mandate, recompute today's spending, decide, and write a
 * sealed record of the decision, whatever it is. A refused attempt leaves evidence too.
 */
export async function attempt(cfg: AgentConfig, req: ActionRequest): Promise<AttemptResult> {
  const now = cfg.now ?? Date.now
  const mandate = await loadMandate(cfg.reader, cfg.mandateKey, cfg.principal)
  const agentMatches = !!mandate && sameAddr(mandate.agent, cfg.writer.address)
  const spentBefore = mandate && agentMatches ? await spentToday(cfg.reader, mandate, req.tsMs) : 0n
  const decision: Decision = mandate
    ? evaluate(mandate.policy, { mandateLive: true, agentMatches, spentToday: spentBefore }, req)
    : { verdict: VERDICT.refused, reason: REASON.noLiveMandate }

  const fields: RecordFields = {
    mandate: cfg.mandateKey,
    kind: req.kind,
    amount: req.amount,
    verdict: decision.verdict,
    reason: decision.reason,
    tsMs: req.tsMs,
  }
  const predicted = await cfg.writer.predictKey()
  const batch = await recordBatch({
    fields,
    details: { ...req.details, counterparty: req.counterparty ?? null, decidedAtMs: now() },
    dataKey: cfg.dataKey,
    retentionDays: mandate?.policy.retentionDays ?? DEFAULTS.retentionDays,
    predicted,
  })
  const res = await cfg.writer.executeBatch(batch)
  const recordKey = res.createdEntities[0]
  if (!recordKey || recordKey.toLowerCase() !== predicted.key.toLowerCase()) {
    // The ownership change named the predicted key; a different minted key means another create
    // from this wallet landed first. The batch is atomic, so the chain rejected or sealed correctly;
    // surface it loudly rather than continue on a wrong assumption.
    throw new Error(`record key mismatch: predicted ${predicted.key}, minted ${recordKey ?? "none"}`)
  }
  await waitVisible(cfg.reader, recordKey, cfg.visibilityTimeoutMs ?? 20_000)
  return { decision, fields, recordKey, txHash: res.txHash, mandate, spentBefore }
}

/** Wait until an entity is visible to queries (the next decision must count it). */
export async function waitVisible(reader: TachoReader, key: Hex, timeoutMs: number, stepMs = 500): Promise<number> {
  const start = Date.now()
  for (;;) {
    if (await reader.getEntity(key)) return Date.now() - start
    if (Date.now() - start > timeoutMs) throw new Error(`entity ${key} not visible after ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

// ---------------------------------------------------------------------------------------------
// Counterparty
// ---------------------------------------------------------------------------------------------

/**
 * Verify a record and, only if every check passes and nobody has acknowledged it yet,
 * write a sealed acknowledgement. Returns the report either way.
 */
export async function honour(
  reader: TachoReader,
  counterparty: TachoWriter,
  recordKey: Hex,
  opts: { expectedPrincipal?: Address; now?: number } = {},
): Promise<{ report: VerifyReport; ackKey?: Hex; txHash?: Hex }> {
  const report = await verifyRecord(reader, recordKey, {
    counterparty: counterparty.address,
    ...(opts.expectedPrincipal ? { expectedPrincipal: opts.expectedPrincipal } : {}),
  })
  const fresh = report.checks.find((c) => c.id === "fresh")?.status === "pass"
  if (!report.ok || !fresh || !report.record || !report.mandate) return { report }
  const predicted = await counterparty.predictKey()
  const res = await counterparty.executeBatch(
    ackBatch({
      fields: { record: recordKey, mandate: report.mandate.key, amount: report.record.amount, tsMs: opts.now ?? Date.now() },
      retentionDays: report.mandate.policy.retentionDays,
      predicted,
    }),
  )
  return { report, ackKey: res.createdEntities[0]!, txHash: res.txHash }
}
