import { describe, expect, it } from "vitest"
import { guardBudget, RpcBudgetError, TIRAMISU_CHAIN } from "../src/core/clients.ts"

const reply = (status: number, headers: Record<string, string>, body = "{}") => async () => new Response(body, { status, headers })

describe("RPC budget guard", () => {
  it("throws at once when the anonymous query budget is used up", async () => {
    const f = guardBudget(reply(429, { "retry-after": "2866" }, '{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted"}') as unknown as typeof fetch)
    const err = await f("https://rpc.example", {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcBudgetError)
    expect((err as RpcBudgetError).retryAfterSeconds).toBe(2866)
    expect((err as RpcBudgetError).message).toContain("ANON_COST_LIMITED")
    expect((err as RpcBudgetError).message).toContain("48 min")
  })

  it("leaves short rate limits to viem's own retry", async () => {
    const f = guardBudget(reply(429, { "retry-after": "5" }) as unknown as typeof fetch)
    expect((await f("https://rpc.example", {})).status).toBe(429)
  })

  it("passes ordinary responses through", async () => {
    const f = guardBudget(reply(200, {}, '{"result":"0x1"}') as unknown as typeof fetch)
    expect(await (await f("https://rpc.example", {})).json()).toEqual({ result: "0x1" })
  })

  it("tells viem the real block time of Tiramisu (2 s)", () => {
    expect(TIRAMISU_CHAIN.blockTime).toBe(2000)
    expect(TIRAMISU_CHAIN.id).toBe(7738577)
  })
})
