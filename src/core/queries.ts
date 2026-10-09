import { addr, key, str, u64 } from "@arkiv-network/sdk/attr"
import { and, eq, gte, lt, lte, not, render, type Expression } from "@arkiv-network/sdk/query"
import { PROJECT, SEAL_ADDRESS, TIRAMISU, TYPE, VERDICT } from "./constants.ts"
import type { Address } from "./policy.ts"
import type { Hex } from "./entities.ts"

/**
 * Every query Tacho runs, as data. The app executes them with the SDK builder, the UI prints them
 * next to the result they produce, and /arkiv/schema.md lists them. `createdBy` is the
 * `$creator` filter: the only part of a query nobody can forge.
 */
export interface QuerySpec {
  id: string
  /** Why the app asks this question, in one line. */
  why: string
  where: Expression[]
  createdBy?: Address
  /** The `$owner` filter (`.ownedBy()`): who controls the entity now. */
  ownedBy?: Address
}

const ns = (type: string): Expression[] => [eq("project", str(PROJECT)), eq("type", str(type))]

/** Mandates naming an agent, from any principal. The UI shows each one's `$creator`. */
export const mandatesForAgent = (agent: Address): QuerySpec => ({
  id: "mandates-for-agent",
  why: "Which principals have granted this agent authority right now? Expired or revoked mandates no longer match.",
  where: [...ns(TYPE.mandate), eq("agent", addr(agent))],
})

/** Mandates a principal has granted. */
export const mandatesByPrincipal = (principal: Address): QuerySpec => ({
  id: "mandates-by-principal",
  why: "Which agents does this principal currently authorise?",
  where: ns(TYPE.mandate),
  createdBy: principal,
})

/** Records the agent itself wrote: the only ones that count. */
export const recordsByAgent = (agent: Address): QuerySpec => ({
  id: "records-by-agent",
  why: "Every action this agent attempted, allowed or refused, newest first. Trusted because $creator is the agent.",
  where: ns(TYPE.record),
  createdBy: agent,
})

/** Records under one mandate written by its agent. */
export const recordsForMandate = (mandate: Hex, agent: Address): QuerySpec => ({
  id: "records-for-mandate",
  why: "What the agent did under this mandate.",
  where: [...ns(TYPE.record), eq("mandate", key(mandate))],
  createdBy: agent,
})

/** Records that claim this mandate but were written by someone other than its agent. */
export const forgeriesForMandate = (mandate: Hex, agent: Address): QuerySpec => ({
  id: "forgeries-for-mandate",
  why: "Anyone can copy our project attribute and point at this mandate. These records did, but $creator is not the agent.",
  where: [...ns(TYPE.record), eq("mandate", key(mandate)), not(eq("$creator", addr(agent)))],
})

/** Allowed spending under a mandate since the start of the policy day: the daily-cap check. */
export const spentSince = (mandate: Hex, agent: Address, fromMs: number, toMs?: number): QuerySpec => ({
  id: "spent-since",
  why: "How much has the agent already spent today? Decides the daily cap, so it filters by number range, not in JavaScript.",
  where: [
    ...ns(TYPE.record),
    eq("mandate", key(mandate)),
    eq("verdict", str(VERDICT.allowed)),
    gte("ts_ms", u64(BigInt(fromMs))),
    ...(toMs === undefined ? [] : [lte("ts_ms", u64(BigInt(toMs)))]),
  ],
  createdBy: agent,
})

/** Records the agent refused: the guardrail at work. */
export const refusalsByAgent = (agent: Address): QuerySpec => ({
  id: "refusals-by-agent",
  why: "Every attempt the policy blocked.",
  where: [...ns(TYPE.record), eq("verdict", str(VERDICT.refused))],
  createdBy: agent,
})

/** Large actions: a numeric range on a typed attribute. */
export const largeActions = (agent: Address, minAmount: bigint): QuerySpec => ({
  id: "large-actions",
  why: "Actions at or above a threshold, for review.",
  where: [...ns(TYPE.record), gte("amount", u64(minAmount))],
  createdBy: agent,
})

/** Evidence about to expire: candidates for a permissionless Lifetime Extension. */
export const expiringRecords = (agent: Address, beforeBlock: bigint): QuerySpec => ({
  id: "expiring-records",
  why: "Records whose retention ends soon. Any wallet can extend them while a dispute is open.",
  where: [...ns(TYPE.record), lt("$expiresAt", u64(beforeBlock))],
  createdBy: agent,
})

/** Acknowledgements of one record, optionally from one counterparty. */
export const acksForRecord = (record: Hex, counterparty?: Address): QuerySpec => ({
  id: "acks-for-record",
  why: "Has a counterparty already honoured this record? Stops the same record being spent twice.",
  where: [...ns(TYPE.ack), eq("record", key(record))],
  ...(counterparty ? { createdBy: counterparty } : {}),
})

/** All acknowledgements citing a mandate: which of its records a counterparty has honoured. */
export const acksForMandate = (mandate: Hex): QuerySpec => ({
  id: "acks-for-mandate",
  why: "Which records under this mandate a counterparty has honoured. The UI trusts an ack only by its $creator.",
  where: [...ns(TYPE.ack), eq("mandate", key(mandate))],
})

/** Records the agent wrote that are still owned by the seal address: deletable by nobody. */
export const sealedByAgent = (agent: Address): QuerySpec => ({
  id: "sealed-by-agent",
  why: "Records whose $owner is the seal address. Nobody holds that key, so nobody can delete them.",
  where: ns(TYPE.record),
  createdBy: agent,
  ownedBy: SEAL_ADDRESS,
})

/** Records the agent wrote that are NOT sealed: their owner could delete them. Should always be empty. */
export const unsealedByAgent = (agent: Address): QuerySpec => ({
  id: "unsealed-by-agent",
  why: "Evidence someone could still delete: records by this agent whose $owner is not the seal address.",
  where: [...ns(TYPE.record), not(eq("$owner", addr(SEAL_ADDRESS)))],
  createdBy: agent,
})

/** Every record in the namespace, from anyone: the public feed, where forgeries show up. */
export const namespaceRecords = (): QuerySpec => ({
  id: "namespace-records",
  why: "All tacho/v1 records from any wallet. The app marks which ones are genuine by checking $creator against the mandate.",
  where: ns(TYPE.record),
})

/** One entity by key: used with atBlock to ask whether a mandate was alive when a record landed. */
export const byKey = (entityKey: Hex): QuerySpec => ({
  id: "by-key",
  why: "Was this entity alive at a given block?",
  where: [eq("$key", key(entityKey))],
})

/** The query language string the node receives. Same text as the SDK builder's toString(). */
export function queryString(spec: QuerySpec): string {
  const parts = [
    ...spec.where,
    ...(spec.ownedBy ? [eq("$owner", addr(spec.ownedBy))] : []),
    ...(spec.createdBy ? [eq("$creator", addr(spec.createdBy))] : []),
  ]
  return render(parts.length === 1 ? parts[0]! : and(parts))
}

/** A copy-paste curl for any query: proof that the data is readable without our app or backend. */
export function curlFor(spec: QuerySpec, opts: { limit?: number; atBlock?: bigint; rpc?: string } = {}): string {
  const options: Record<string, unknown> = {
    select: { key: true, owner: true, creator: true, createdAt: true, expiresAt: true, attributes: true },
    limit: "0x" + (opts.limit ?? 50).toString(16),
  }
  if (opts.atBlock !== undefined) options.atBlock = "0x" + opts.atBlock.toString(16)
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [queryString(spec), options] })
  return `curl -s ${opts.rpc ?? TIRAMISU.http} -H 'content-type: application/json' -d '${body.replace(/'/g, "'\\''")}'`
}
