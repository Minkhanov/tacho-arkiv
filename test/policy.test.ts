import { describe, expect, it } from "vitest"
import { REASON, VERDICT } from "../src/core/constants.ts"
import { dayWindow, demoPolicy, evaluate, formatAmount, parsePolicy, policyToJson, PolicyError, type ActionRequest } from "../src/core/policy.ts"

const policy = demoPolicy()
const live = { mandateLive: true, agentMatches: true, spentToday: 0n }
const req = (over: Partial<ActionRequest> = {}): ActionRequest => ({ kind: "fuel", amount: 1_240_000n, tsMs: Date.UTC(2026, 9, 9, 9), details: {}, ...over })

describe("evaluate", () => {
  it("allows an action inside every limit", () => {
    expect(evaluate(policy, live, req())).toEqual({ verdict: VERDICT.allowed, reason: REASON.ok })
  })

  it("refuses without a live mandate before looking at anything else", () => {
    expect(evaluate(policy, { ...live, mandateLive: false }, req({ kind: "repair", amount: -1n }))).toEqual({ verdict: VERDICT.refused, reason: REASON.noLiveMandate })
  })

  it("refuses when the mandate names another agent", () => {
    expect(evaluate(policy, { ...live, agentMatches: false }, req()).reason).toBe(REASON.wrongAgent)
  })

  it("refuses kinds the principal did not grant", () => {
    expect(evaluate(policy, live, req({ kind: "repair" })).reason).toBe(REASON.kindNotAllowed)
  })

  it("refuses zero and negative amounts", () => {
    expect(evaluate(policy, live, req({ amount: 0n })).reason).toBe(REASON.invalidAmount)
  })

  it("treats the per-action cap as inclusive", () => {
    expect(evaluate(policy, live, req({ amount: 1_500_000n })).verdict).toBe(VERDICT.allowed)
    expect(evaluate(policy, live, req({ amount: 1_500_001n })).reason).toBe(REASON.overActionCap)
  })

  it("treats the daily cap as inclusive and counts what was already spent", () => {
    expect(evaluate(policy, { ...live, spentToday: 3_000_000n }, req({ amount: 1_000_000n })).verdict).toBe(VERDICT.allowed)
    expect(evaluate(policy, { ...live, spentToday: 3_000_001n }, req({ amount: 1_000_000n })).reason).toBe(REASON.overDayCap)
  })

  it("enforces a counterparty allowlist case-insensitively", () => {
    const p = demoPolicy({ counterparties: ["0x00cb37E03ec19cf0539cb50478B3CFf4e386ED59"] })
    expect(evaluate(p, live, req({ counterparty: "0x00cb37e03ec19cf0539cb50478b3cff4e386ed59" })).verdict).toBe(VERDICT.allowed)
    expect(evaluate(p, live, req({ counterparty: "0x9288957a5294c7210796aBb6F8384a09Be35622E" })).reason).toBe(REASON.counterpartyNotAllowed)
    expect(evaluate(p, live, req()).reason).toBe(REASON.counterpartyNotAllowed)
  })
})

describe("dayWindow", () => {
  it("starts the Moscow day at 21:00 UTC", () => {
    const { startMs, endMs } = dayWindow(Date.UTC(2026, 9, 9, 22, 30), 180)
    expect(new Date(startMs).toISOString()).toBe("2026-10-09T21:00:00.000Z")
    expect(endMs - startMs).toBe(86_400_000)
  })
  it("puts 20:59 UTC in the previous Moscow day", () => {
    expect(new Date(dayWindow(Date.UTC(2026, 9, 9, 20, 59), 180).startMs).toISOString()).toBe("2026-10-08T21:00:00.000Z")
  })
  it("handles UTC and negative offsets", () => {
    expect(new Date(dayWindow(Date.UTC(2026, 9, 9, 0, 0), 0).startMs).toISOString()).toBe("2026-10-09T00:00:00.000Z")
    expect(new Date(dayWindow(Date.UTC(2026, 9, 9, 3, 0), -300).startMs).toISOString()).toBe("2026-10-08T05:00:00.000Z")
  })
})

describe("policy JSON", () => {
  it("round-trips through the mandate payload with exact bigints", () => {
    const json = JSON.parse(JSON.stringify(policyToJson(policy)))
    expect(json.perActionCap).toBe("1500000")
    expect(parsePolicy(json)).toEqual(policy)
  })

  it.each([
    ["wrong version", { v: 2 }],
    ["float cap", { perActionCap: 15.5 }],
    ["upper-case kind", { kinds: ["Fuel"] }],
    ["empty kinds", { kinds: [] }],
    ["odd lease (not whole blocks)", { leaseSeconds: 901 }],
    ["action cap above day cap", { perActionCap: "5000000" }],
    ["bad counterparty", { counterparties: ["not-an-address"] }],
  ])("rejects %s", (_name, patch) => {
    const raw = { ...policyToJson(policy), ...patch }
    expect(() => parsePolicy(raw)).toThrow(PolicyError)
  })
})

describe("formatAmount", () => {
  it("formats minor units with thin grouping", () => {
    expect(formatAmount(1_250_000n, 2)).toBe("12 500.00")
    expect(formatAmount(5n, 2)).toBe("0.05")
    expect(formatAmount(1234567n, 0)).toBe("1 234 567")
  })
})
