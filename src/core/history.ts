import { ENTITY_EVENTS_ABI, type PublicArkivClient } from "@arkiv-network/sdk"
import { decodeEventLog, type Log } from "viem"
import type { Hex } from "./entities.ts"

/** The address that emits every Arkiv entity event (from the SDK's watcher). */
export const ARKIV_EVENTS_ADDRESS = "0x4400000000000000000000000000000000000044" as const

export interface LifecycleEvent {
  type: "EntityCreated" | "ExpiryExtended" | "EntityDeleted" | "OwnershipTransferred" | "EntityPatched"
  block: bigint
  txHash: Hex
  /** New expiry for EntityCreated / ExpiryExtended. */
  expiresAt?: bigint
}

export type MandateFate = { state: "live"; expiresAt: bigint } | { state: "revoked"; block: bigint; txHash: Hex } | { state: "expired"; block: bigint }

/**
 * Decode raw logs for one entity into its lifecycle, oldest first. Kept separate from the RPC
 * call so it can be tested without a node.
 */
export function toLifecycle(logs: Array<Pick<Log, "topics" | "data" | "blockNumber" | "transactionHash" | "logIndex">>): LifecycleEvent[] {
  const out: LifecycleEvent[] = []
  for (const log of logs) {
    if (log.blockNumber === null || log.transactionHash === null) continue
    try {
      const ev = decodeEventLog({ abi: ENTITY_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      const e: LifecycleEvent = { type: ev.eventName, block: log.blockNumber, txHash: log.transactionHash }
      if ("expiresAt" in ev.args) e.expiresAt = ev.args.expiresAt as bigint
      out.push(e)
    } catch {
      /* not an entity event */
    }
  }
  return out.sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1))
}

/** What happened to an entity: still live, deleted (revoked) in a transaction, or expired at a block. */
export function fateOf(events: LifecycleEvent[], head: bigint, liveExpiresAt?: bigint): MandateFate {
  if (liveExpiresAt !== undefined && liveExpiresAt > head) return { state: "live", expiresAt: liveExpiresAt }
  const del = events.find((e) => e.type === "EntityDeleted")
  if (del) return { state: "revoked", block: del.block, txHash: del.txHash }
  const lastExpiry = [...events].reverse().find((e) => e.expiresAt !== undefined)?.expiresAt
  return { state: "expired", block: lastExpiry ?? head }
}

/** Tiramisu's public RPC rejects eth_getLogs ranges above 100 000 blocks. */
export const MAX_LOG_RANGE = 100_000n

/**
 * Read one entity's lifecycle from the chain's event logs: eth_getLogs with topics
 * `[any event, entityKey]`, since every entity event indexes the key as its first topic. This is
 * how the inspector tells a revoked mandate from one whose lease ran out.
 */
export async function lifecycle(client: PublicArkivClient, entityKey: Hex, fromBlock: bigint, toBlock: bigint): Promise<LifecycleEvent[]> {
  const hex = (n: bigint) => `0x${n.toString(16)}`
  const out: LifecycleEvent[] = []
  for (let from = fromBlock; from <= toBlock; from += MAX_LOG_RANGE) {
    const to = from + MAX_LOG_RANGE - 1n < toBlock ? from + MAX_LOG_RANGE - 1n : toBlock
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [{ address: ARKIV_EVENTS_ADDRESS, fromBlock: hex(from), toBlock: hex(to), topics: [null, entityKey] }],
    } as never)) as Array<{ topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex }>
    out.push(
      ...toLifecycle(
        raw.map((l) => ({ topics: l.topics as [Hex, ...Hex[]], data: l.data, blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash, logIndex: Number(l.logIndex) })),
      ),
    )
  }
  return out
}
