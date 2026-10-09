import { describe, expect, it } from "vitest"
import { ENTITY_EVENTS_ABI } from "@arkiv-network/sdk"
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem"
import { fateOf, toLifecycle } from "../src/core/history.ts"

const KEY = ("0x" + "ab".repeat(32)) as Hex
const OWNER = "0x4B25c7E2e178D275Ff3285f2832Bb29D13Bd0591"
const tx = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex

function log(eventName: "EntityCreated" | "ExpiryExtended" | "EntityDeleted", block: bigint, extra: { expiresAt?: bigint } = {}) {
  const topics = encodeEventTopics({ abi: ENTITY_EVENTS_ABI, eventName, args: { entityKey: KEY, owner: OWNER } as never }) as [Hex, ...Hex[]]
  const data =
    eventName === "EntityCreated"
      ? encodeAbiParameters([{ type: "uint64" }, { type: "uint8" }], [extra.expiresAt!, 1])
      : eventName === "ExpiryExtended"
        ? encodeAbiParameters([{ type: "uint64" }], [extra.expiresAt!])
        : "0x"
  return { topics, data: data as Hex, blockNumber: block, transactionHash: tx(Number(block)), logIndex: 0 }
}

describe("mandate lifecycle from event logs", () => {
  const created = log("EntityCreated", 100n, { expiresAt: 550n })
  const hb1 = log("ExpiryExtended", 400n, { expiresAt: 850n })
  const hb2 = log("ExpiryExtended", 700n, { expiresAt: 1150n })

  it("decodes created, heartbeats and deletion in block order", () => {
    const ev = toLifecycle([hb2, created, log("EntityDeleted", 900n), hb1])
    expect(ev.map((e) => `${e.type}@${e.block}`)).toEqual(["EntityCreated@100", "ExpiryExtended@400", "ExpiryExtended@700", "EntityDeleted@900"])
    expect(ev[2]!.expiresAt).toBe(1150n)
  })

  it("tells a revocation from an expired lease", () => {
    expect(fateOf(toLifecycle([created, hb1, log("EntityDeleted", 600n)]), 2_000n)).toMatchObject({ state: "revoked", block: 600n })
    expect(fateOf(toLifecycle([created, hb1, hb2]), 2_000n)).toEqual({ state: "expired", block: 1150n })
    expect(fateOf(toLifecycle([created, hb1]), 700n, 850n)).toEqual({ state: "live", expiresAt: 850n })
  })

  it("ignores logs that are not entity events", () => {
    expect(toLifecycle([{ topics: [tx(1)], data: "0x", blockNumber: 5n, transactionHash: tx(5), logIndex: 0 }])).toEqual([])
  })
})
