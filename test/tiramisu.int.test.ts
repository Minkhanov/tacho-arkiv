/**
 * End-to-end on the live Tiramisu testnet: the same flows as flow.test.ts, against the real chain.
 *   npm run test:integration          (needs funded keys in .env; loads it with --env-file)
 * Skips itself when the keys are missing or unfunded, so CI without secrets stays green.
 */
import { describe, expect, it } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { REASON, SEAL_ADDRESS, VERDICT } from "../src/core/constants.ts"
import { parseRecord, recordBatch, type Hex } from "../src/core/entities.ts"
import { generateDataKey } from "../src/core/crypto.ts"
import { attempt, honour, issueMandate, revokeMandate, waitVisible, type AgentConfig } from "../src/core/ops.ts"
import { demoPolicy } from "../src/core/policy.ts"
import { forgeriesForMandate } from "../src/core/queries.ts"
import { verifyRecord } from "../src/core/verify.ts"

// vitest does not read .env; load it the same way `tsx --env-file` would.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
  }
}

const env = await import("../src/cli/env.ts")
const ready = await (async () => {
  try {
    const pc = env.publicClient()
    for (const r of ["principal", "agent", "counterparty", "forger"] as const) {
      if ((await pc.getBalance({ address: env.addressOf(r) })) === 0n) return false
    }
    env.dataKey()
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!ready)("Tiramisu end-to-end", () => {
  const rd = env.reader()
  let cfg: AgentConfig
  let allowedKey: Hex

  it("issues a mandate, and the agent allows and refuses within it", async () => {
    const { mandateKey } = await issueMandate(env.writerOf("principal"), env.addressOf("agent"), demoPolicy({ leaseSeconds: 300, purpose: "integration test (synthetic)" }))
    await waitVisible(rd, mandateKey, 20_000)
    cfg = { reader: rd, writer: env.writerOf("agent"), mandateKey, principal: env.addressOf("principal"), dataKey: env.dataKey() }
    const ok = await attempt(cfg, { kind: "fuel", amount: 1_240_000n, tsMs: Date.now(), details: { vehicle: "TRK-INT" } })
    expect(ok.decision.verdict).toBe(VERDICT.allowed)
    allowedKey = ok.recordKey
    const no = await attempt(cfg, { kind: "fuel", amount: 1_800_000n, tsMs: Date.now(), details: { vehicle: "TRK-INT" } })
    expect(no.decision.reason).toBe(REASON.overActionCap)
    const rec = parseRecord((await rd.getEntity(allowedKey))!)
    expect(rec.owner.toLowerCase()).toBe(SEAL_ADDRESS.toLowerCase())
    expect(rec.readonly && rec.permissionlessExtension).toBe(true)
  })

  it("lets the counterparty honour a genuine record once", async () => {
    const first = await honour(rd, env.writerOf("counterparty"), allowedKey, { expectedPrincipal: env.addressOf("principal") })
    expect(first.report.ok).toBe(true)
    expect(first.ackKey).toBeDefined()
    await waitVisible(rd, first.ackKey!, 20_000)
    const again = await verifyRecord(rd, allowedKey, { expectedPrincipal: env.addressOf("principal"), counterparty: env.addressOf("counterparty") })
    expect(again.checks.find((c) => c.id === "fresh")!.status).toBe("warn")
  })

  it("exposes a forgery by $creator", async () => {
    const forger = env.writerOf("forger")
    const predicted = await forger.predictKey()
    const batch = await recordBatch({
      fields: { mandate: cfg.mandateKey, kind: "fuel", amount: 9_000_000n, verdict: VERDICT.allowed, reason: REASON.ok, tsMs: Date.now() },
      details: {},
      dataKey: generateDataKey(),
      retentionDays: 1,
      predicted,
    })
    const key = (await forger.executeBatch(batch)).createdEntities[0]!
    await waitVisible(rd, key, 20_000)
    const report = await verifyRecord(rd, key, { expectedPrincipal: env.addressOf("principal") })
    expect(report.checks.find((c) => c.id === "author")!.status).toBe("fail")
    const forged = await rd.find(forgeriesForMandate(cfg.mandateKey, env.addressOf("agent")))
    expect(forged.map((e) => e.key)).toContain(key)
  })

  it("stops the agent once the mandate is revoked", async () => {
    await revokeMandate(env.writerOf("principal"), cfg.mandateKey)
    const r = await attempt(cfg, { kind: "fuel", amount: 100_000n, tsMs: Date.now(), details: {} })
    expect(r.decision.reason).toBe(REASON.noLiveMandate)
    const report = await verifyRecord(rd, r.recordKey, { expectedPrincipal: env.addressOf("principal") })
    expect(report.checks.find((c) => c.id === "mandate")!.status).toBe("fail")
  })
})

describe.skipIf(ready)("Tiramisu end-to-end (skipped)", () => {
  it.skip("needs funded keys in .env: see README › Run it yourself", () => undefined)
})
