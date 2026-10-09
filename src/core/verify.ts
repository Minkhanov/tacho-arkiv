import { VERDICT } from "./constants.ts"
import { parseAck, parseMandate, parseRecord, sameAddr, SchemaError, type Hex, type Mandate, type TachoRecord } from "./entities.ts"
import { dayWindow, formatAmount, type Address } from "./policy.ts"
import { acksForRecord, byKey, queryString, spentSince, type QuerySpec } from "./queries.ts"
import type { TachoReader } from "./reader.ts"

export type CheckStatus = "pass" | "fail" | "warn" | "skip"

export interface Check {
  id: string
  label: string
  status: CheckStatus
  detail: string
  /** The query that produced the evidence, when there is one. */
  query?: string
}

export interface VerifyReport {
  ok: boolean
  record?: TachoRecord
  mandate?: Mandate
  checks: Check[]
}

export interface VerifyOptions {
  /** The principal the counterparty expects, for example the fleet it has a contract with. */
  expectedPrincipal?: Address
  /** Look for an existing acknowledgement from this counterparty (double-spend check). */
  counterparty?: Address
  /** Allowed gap between the record's ts_ms and its block time. */
  clockSkewMs?: number
}

/**
 * What a counterparty runs before it honours an agent's action. It trusts nothing the agent says
 * about itself: authorship comes from `$creator`, the mandate is read as of the record's block,
 * and the daily cap is recomputed from the agent's own records at that block.
 */
export async function verifyRecord(reader: TachoReader, recordKey: Hex, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const checks: Check[] = []
  const add = (c: Check) => checks.push(c)
  const done = (): VerifyReport => ({ ok: checks.every((c) => c.status !== "fail"), checks })

  const recEntity = await reader.getEntity(recordKey)
  if (!recEntity) {
    add({ id: "record", label: "Record exists on Arkiv", status: "fail", detail: "No live entity with this key: never written, or past its retention." })
    return done()
  }
  let record: TachoRecord
  try {
    record = parseRecord(recEntity)
  } catch (err) {
    add({ id: "record", label: "Record exists on Arkiv", status: "fail", detail: `Not a tacho/v1 record: ${(err as Error).message}` })
    return done()
  }
  add({ id: "record", label: "Record exists on Arkiv", status: "pass", detail: `Written at block ${record.createdAt} by ${record.writer}.` })

  const sealed = record.sealed && record.readonly && record.permissionlessExtension
  add({
    id: "sealed",
    label: "Sealed: nobody can edit or delete it",
    status: sealed ? "pass" : "fail",
    detail: sealed
      ? "Owner is the seal address, readonly is set, and any party may extend its retention."
      : `owner=${record.owner} readonly=${record.readonly} permissionlessExtension=${record.permissionlessExtension}`,
  })

  const mandateAt = await reader.getEntityAt(record.mandate, record.createdAt)
  const atBlockQuery = queryString(byKey(record.mandate)) + `  (atBlock ${record.createdAt})`
  if (!mandateAt) {
    add({ id: "mandate", label: "Mandate was alive when the record landed", status: "fail", detail: `Mandate ${record.mandate} did not exist at block ${record.createdAt}: expired, revoked or never issued.`, query: atBlockQuery })
    const r = done()
    r.record = record
    return r
  }
  let mandate: Mandate
  try {
    mandate = parseMandate(mandateAt)
  } catch (err) {
    add({ id: "mandate", label: "Mandate was alive when the record landed", status: "fail", detail: `Referenced entity is not a valid mandate: ${(err as Error).message}`, query: atBlockQuery })
    const r = done()
    r.record = record
    return r
  }
  add({ id: "mandate", label: "Mandate was alive when the record landed", status: "pass", detail: `Alive at block ${record.createdAt}; issued by ${mandate.principal}.`, query: atBlockQuery })

  if (opts.expectedPrincipal) {
    const ok = sameAddr(mandate.principal, opts.expectedPrincipal)
    add({ id: "principal", label: "Mandate issued by the expected principal ($creator)", status: ok ? "pass" : "fail", detail: ok ? `$creator ${mandate.principal}` : `$creator is ${mandate.principal}, expected ${opts.expectedPrincipal}` })
  } else {
    add({ id: "principal", label: "Mandate issued by the expected principal ($creator)", status: "warn", detail: `No expected principal given. The mandate's $creator is ${mandate.principal}; check it is who you think.` })
  }

  const authorOk = sameAddr(record.writer, mandate.agent)
  add({
    id: "author",
    label: "Written by the agent the mandate names ($creator)",
    status: authorOk ? "pass" : "fail",
    detail: authorOk ? `$creator ${record.writer} is the mandate's agent.` : `FORGED: $creator ${record.writer} is not the mandate's agent ${mandate.agent}.`,
  })

  const p = mandate.policy
  const amountTxt = `${formatAmount(record.amount, p.decimals)} ${p.currency}`
  add({ id: "verdict", label: "Agent's verdict is allowed", status: record.verdict === VERDICT.allowed ? "pass" : "fail", detail: `${record.verdict} (${record.reason})` })
  const kindOk = p.kinds.includes(record.kind)
  const capOk = record.amount > 0n && record.amount <= p.perActionCap
  add({
    id: "policy",
    label: "Within the mandate's per-action rules",
    status: kindOk && capOk ? "pass" : "fail",
    detail: `${record.kind} ${amountTxt}; allowed kinds ${p.kinds.join(", ")}; per-action cap ${formatAmount(p.perActionCap, p.decimals)}`,
  })

  // Recompute the day's spending from the agent's own records, as of the record's block.
  const { startMs } = dayWindow(record.tsMs, p.dayOffsetMinutes)
  const spec: QuerySpec = spentSince(record.mandate, mandate.agent, startMs, record.tsMs)
  const dayRecords = (await reader.find(spec, { atBlock: record.createdAt })).map((e) => {
    try {
      return parseRecord(e)
    } catch (err) {
      if (err instanceof SchemaError) return null
      throw err
    }
  })
  const spent = dayRecords.reduce((sum, r) => (r && sameAddr(r.writer, mandate.agent) ? sum + r.amount : sum), 0n)
  add({
    id: "daycap",
    label: "Within the daily cap (recomputed, not taken from the agent)",
    status: spent <= p.perDayCap ? "pass" : "fail",
    detail: `${formatAmount(spent, p.decimals)} of ${formatAmount(p.perDayCap, p.decimals)} ${p.currency} spent this policy day, including this record.`,
    query: queryString(spec) + `  (atBlock ${record.createdAt})`,
  })

  const blockMs = await reader.blockTimeMs(record.createdAt)
  const skew = Math.abs(blockMs - record.tsMs)
  const maxSkew = opts.clockSkewMs ?? 120_000
  add({
    id: "clock",
    label: "Timestamp agrees with the block time",
    status: skew <= maxSkew ? "pass" : "fail",
    detail: `ts_ms is ${Math.round(skew / 1000)} s from block ${record.createdAt} time (limit ${maxSkew / 1000} s).`,
  })

  const ackSpec = acksForRecord(record.key, opts.counterparty)
  const acks = (await reader.find(ackSpec, { max: 20 })).flatMap((e) => {
    try {
      return [parseAck(e)]
    } catch {
      return []
    }
  })
  add({
    id: "fresh",
    label: "Not honoured before",
    status: acks.length === 0 ? "pass" : "warn",
    detail: acks.length === 0 ? "No acknowledgement exists for this record." : `Already acknowledged ${acks.length}× (first by ${acks[acks.length - 1]!.writer}).`,
    query: queryString(ackSpec),
  })

  return { ...done(), record, mandate }
}

/** Genuine when the record's `$creator` is the agent its mandate names. */
export function isGenuine(record: TachoRecord, mandate: Pick<Mandate, "agent">): boolean {
  return sameAddr(record.writer, mandate.agent)
}
