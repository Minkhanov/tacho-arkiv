import { describe, expect, it } from "vitest"
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import { curlFor, forgeriesForMandate, mandatesForAgent, queryString, recordsByAgent, sealedByAgent, spentSince } from "../src/core/queries.ts"
import type { Hex } from "../src/core/entities.ts"
import { WALLETS } from "./fake-arkiv.ts"

const M = ("0x" + "ab".repeat(32)) as Hex

describe("query strings (what the node receives)", () => {
  it("filters trusted records by $creator, not by an attribute", () => {
    expect(queryString(recordsByAgent(WALLETS.agent))).toBe(
      "project = str('tacho/v1') AND type = str('record') AND $creator = addr(0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f)",
    )
  })

  it("finds forgeries with a compound predicate and NOT on $creator", () => {
    expect(queryString(forgeriesForMandate(M, WALLETS.agent))).toBe(
      `project = str('tacho/v1') AND type = str('record') AND mandate = key(${M}) AND NOT $creator = addr(0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f)`,
    )
  })

  it("computes the daily cap with a typed numeric range", () => {
    expect(queryString(spentSince(M, WALLETS.agent, 1_791_500_000_000, 1_791_534_000_000))).toBe(
      `project = str('tacho/v1') AND type = str('record') AND mandate = key(${M}) AND verdict = str('allowed') AND ts_ms >= u64(1791500000000) AND ts_ms <= u64(1791534000000) AND $creator = addr(0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f)`,
    )
  })

  it("matches the SDK builder's own rendering of the same query", () => {
    const client = createPublicClient({ chain: tiramisu, transport: http() })
    const spec = recordsByAgent(WALLETS.agent)
    const built = client.select({ key: true }).where(spec.where).createdBy(spec.createdBy!).toString()
    expect(built).toBe(queryString(spec))
    const m = mandatesForAgent(WALLETS.agent)
    expect(client.select({ key: true }).where(m.where).toString()).toBe(queryString(m))
    const sealed = sealedByAgent(WALLETS.agent)
    expect(client.select({ key: true }).where(sealed.where).ownedBy(sealed.ownedBy!).createdBy(sealed.createdBy!).toString()).toBe(queryString(sealed))
  })

  it("produces a shell-safe curl that reads Arkiv without our app", () => {
    const c = curlFor(recordsByAgent(WALLETS.agent), { limit: 10, atBlock: 345_000n })
    expect(c).toContain("https://rpc.tiramisu.db-chain.testnet.arkiv.network")
    expect(c).toContain(`"method":"arkiv_query"`)
    expect(c).toContain(`"limit":"0xa"`)
    expect(c).toContain(`"atBlock":"0x543a8"`)
    expect(c).toContain(`str('\\''tacho/v1'\\'')`)
  })
})
