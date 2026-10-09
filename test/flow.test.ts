import { beforeEach, describe, expect, it } from "vitest"
import { ExpirationTime } from "@arkiv-network/sdk"
import { REASON, SEAL_ADDRESS, VERDICT } from "../src/core/constants.ts"
import { generateDataKey, unseal } from "../src/core/crypto.ts"
import { parseRecord, recordAad, recordBatch } from "../src/core/entities.ts"
import { attempt, honour, issueMandate, renewMandate, revokeMandate, type AgentConfig } from "../src/core/ops.ts"
import { demoPolicy, type ActionRequest } from "../src/core/policy.ts"
import { forgeriesForMandate, recordsByAgent, sealedByAgent, unsealedByAgent } from "../src/core/queries.ts"
import { isGenuine, verifyRecord } from "../src/core/verify.ts"
import { FakeArkiv, WALLETS } from "./fake-arkiv.ts"

let chain: FakeArkiv
let cfg: AgentConfig
const dataKey = generateDataKey()

const act = (kind: string, rub: number, extra: Partial<ActionRequest> = {}): ActionRequest => ({
  kind,
  amount: BigInt(rub) * 100n,
  tsMs: chain.timeMs(),
  details: { vehicle: "TRK-07", note: "synthetic" },
  ...extra,
})

beforeEach(async () => {
  chain = new FakeArkiv()
  const principal = chain.writer(WALLETS.principal)
  const { mandateKey } = await issueMandate(principal, WALLETS.agent, demoPolicy(), chain.timeMs())
  cfg = {
    reader: chain.reader(),
    writer: chain.writer(WALLETS.agent),
    mandateKey,
    principal: WALLETS.principal,
    dataKey,
    now: () => chain.timeMs(),
    visibilityTimeoutMs: 100,
  }
})

describe("agent under a mandate", () => {
  it("allows, refuses and records every attempt, enforcing both caps from chain data", async () => {
    const results = []
    for (const [kind, rub] of [
      ["fuel", 12_400],
      ["fuel", 18_000], // over the 15 000 per-action cap
      ["toll", 3_200],
      ["repair", 25_000], // kind not granted
      ["fuel", 14_900],
      ["fuel", 11_000], // 12 400 + 3 200 + 14 900 + 11 000 > 40 000 per day
    ] as const) {
      results.push(await attempt(cfg, act(kind, rub)))
    }
    expect(results.map((r) => r.decision.reason)).toEqual([REASON.ok, REASON.overActionCap, REASON.ok, REASON.kindNotAllowed, REASON.ok, REASON.overDayCap])
    expect(results[5]!.spentBefore).toBe(3_050_000n)

    const rows = await chain.reader().find(recordsByAgent(WALLETS.agent))
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      const r = parseRecord(row)
      expect(r.sealed && r.readonly && r.permissionlessExtension).toBe(true)
      expect(r.owner).toBe(SEAL_ADDRESS)
    }
  })

  it("keeps details private: only the data key opens them", async () => {
    const { recordKey, fields } = await attempt(cfg, act("fuel", 12_400))
    const r = parseRecord((await chain.reader().getEntity(recordKey))!)
    expect(JSON.stringify(r.envelope)).not.toContain("TRK-07")
    const details = await unseal<Record<string, unknown>>(r.envelope, dataKey, recordAad(fields))
    expect(details.vehicle).toBe("TRK-07")
  })

  it("loses authority when the principal stops renewing the lease", async () => {
    expect((await attempt(cfg, act("fuel", 1_000))).decision.verdict).toBe(VERDICT.allowed)
    chain.mine(450n) // 15 minutes of blocks, no heartbeat
    const r = await attempt(cfg, act("fuel", 1_000))
    expect(r.decision).toEqual({ verdict: VERDICT.refused, reason: REASON.noLiveMandate })
  })

  it("keeps authority while the principal renews the lease", async () => {
    const principal = chain.writer(WALLETS.principal)
    chain.mine(400n)
    await renewMandate(principal, cfg.mandateKey, 900)
    chain.mine(400n)
    expect((await attempt(cfg, act("fuel", 1_000))).decision.verdict).toBe(VERDICT.allowed)
  })

  it("stops at once when the principal revokes", async () => {
    await revokeMandate(chain.writer(WALLETS.principal), cfg.mandateKey)
    expect((await attempt(cfg, act("fuel", 1_000))).decision.reason).toBe(REASON.noLiveMandate)
  })

  it("ignores a mandate from a principal it does not work for", async () => {
    const stranger = chain.writer(WALLETS.forger)
    const { mandateKey } = await issueMandate(stranger, WALLETS.agent, demoPolicy({ perActionCap: 4_000_000n }), chain.timeMs())
    const r = await attempt({ ...cfg, mandateKey }, act("fuel", 30_000))
    expect(r.decision.reason).toBe(REASON.noLiveMandate)
  })

  it("only lets the principal renew: the mandate has no permissionless extension", async () => {
    await expect(renewMandate(chain.writer(WALLETS.agent), cfg.mandateKey, 900)).rejects.toThrow("NotOwner")
  })
})

describe("sealed evidence", () => {
  it("cannot be deleted by the agent's operator", async () => {
    const { recordKey } = await attempt(cfg, act("fuel", 12_400))
    await expect(chain.writer(WALLETS.agent).deleteEntity({ entityKey: recordKey })).rejects.toThrow("NotOwner")
  })

  it("is found by $owner: every record is owned by the seal address, and an unsealed one stands out", async () => {
    await attempt(cfg, act("fuel", 12_400))
    await attempt(cfg, act("fuel", 18_000))
    expect(await chain.reader().find(sealedByAgent(WALLETS.agent))).toHaveLength(2)
    expect(await chain.reader().find(unsealedByAgent(WALLETS.agent))).toHaveLength(0)
    // A runtime that skips the seal (a plain create) shows up in the unsealed query.
    const agent = chain.writer(WALLETS.agent)
    const predicted = await agent.predictKey()
    const batch = await recordBatch({
      fields: { mandate: cfg.mandateKey, kind: "fuel", amount: 1n, verdict: VERDICT.allowed, reason: REASON.ok, tsMs: chain.timeMs() },
      details: {},
      dataKey,
      retentionDays: 45,
      predicted,
    })
    await agent.createEntity(batch.creates![0]!)
    expect(await chain.reader().find(unsealedByAgent(WALLETS.agent))).toHaveLength(1)
  })

  it("can be kept alive by any party during a dispute", async () => {
    const { recordKey } = await attempt(cfg, act("fuel", 12_400))
    const before = (await chain.reader().getEntity(recordKey))!.expiresAt!
    const { expiresAt } = await chain.writer(WALLETS.counterparty).extendEntity({ entityKey: recordKey, expires: ExpirationTime.fromDays(60) })
    expect(expiresAt).toBeGreaterThan(before)
  })
})

describe("counterparty verification", () => {
  it("passes a genuine allowed record and acknowledges it exactly once", async () => {
    const { recordKey } = await attempt(cfg, act("fuel", 12_400, { counterparty: WALLETS.counterparty }))
    const cp = chain.writer(WALLETS.counterparty)
    const first = await honour(chain.reader(), cp, recordKey, { expectedPrincipal: WALLETS.principal, now: chain.timeMs() })
    expect(first.report.ok).toBe(true)
    expect(first.ackKey).toBeDefined()
    const second = await honour(chain.reader(), cp, recordKey, { expectedPrincipal: WALLETS.principal })
    expect(second.ackKey).toBeUndefined()
    expect(second.report.checks.find((c) => c.id === "fresh")!.status).toBe("warn")
  })

  it("fails a refused record", async () => {
    const { recordKey } = await attempt(cfg, act("fuel", 18_000))
    const report = await verifyRecord(chain.reader(), recordKey, { expectedPrincipal: WALLETS.principal })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.id === "verdict")!.status).toBe("fail")
  })

  it("catches a forgery that copies every attribute but not $creator", async () => {
    await attempt(cfg, act("fuel", 12_400))
    const forger = chain.writer(WALLETS.forger)
    const predicted = await forger.predictKey()
    const fake = await recordBatch({
      fields: { mandate: cfg.mandateKey, kind: "fuel", amount: 9_000_000n, verdict: VERDICT.allowed, reason: REASON.ok, tsMs: chain.timeMs() },
      details: { vehicle: "TRK-07" },
      dataKey: generateDataKey(),
      retentionDays: 45,
      predicted,
    })
    const { createdEntities } = await forger.executeBatch(fake)
    const forgedKey = createdEntities[0]!

    const report = await verifyRecord(chain.reader(), forgedKey, { expectedPrincipal: WALLETS.principal })
    expect(report.ok).toBe(false)
    expect(report.checks.find((c) => c.id === "author")!.detail).toMatch(/^FORGED/)

    // The inspector's forgery query finds it; the trusted query does not.
    const forged = await chain.reader().find(forgeriesForMandate(cfg.mandateKey, WALLETS.agent))
    expect(forged.map((e) => e.key)).toEqual([forgedKey])
    const trusted = await chain.reader().find(recordsByAgent(WALLETS.agent))
    expect(trusted.map((e) => e.key)).not.toContain(forgedKey)
    expect(isGenuine(parseRecord(forged[0]!), { agent: WALLETS.agent })).toBe(false)
  })

  it("rejects a record written after the mandate was revoked, even though the record itself is genuine", async () => {
    // A rogue runtime that skips the mandate check still cannot get paid.
    await revokeMandate(chain.writer(WALLETS.principal), cfg.mandateKey)
    const agent = chain.writer(WALLETS.agent)
    const predicted = await agent.predictKey()
    const batch = await recordBatch({
      fields: { mandate: cfg.mandateKey, kind: "fuel", amount: 1_000_000n, verdict: VERDICT.allowed, reason: REASON.ok, tsMs: chain.timeMs() },
      details: {},
      dataKey,
      retentionDays: 45,
      predicted,
    })
    const { createdEntities } = await agent.executeBatch(batch)
    const report = await verifyRecord(chain.reader(), createdEntities[0]!, { expectedPrincipal: WALLETS.principal })
    expect(report.checks.find((c) => c.id === "mandate")!.status).toBe("fail")
    expect(report.ok).toBe(false)
  })

  it("recomputes the daily cap instead of trusting the agent's verdict", async () => {
    const agent = chain.writer(WALLETS.agent)
    // A rogue runtime marks five 10 000 RUB fuel buys as allowed: 50 000 > the 40 000 daily cap.
    let last = ""
    for (let i = 0; i < 5; i++) {
      const predicted = await agent.predictKey()
      const batch = await recordBatch({
        fields: { mandate: cfg.mandateKey, kind: "fuel", amount: 1_000_000n, verdict: VERDICT.allowed, reason: REASON.ok, tsMs: chain.timeMs() },
        details: {},
        dataKey,
        retentionDays: 45,
        predicted,
      })
      last = (await agent.executeBatch(batch)).createdEntities[0]!
    }
    const report = await verifyRecord(chain.reader(), last as `0x${string}`, { expectedPrincipal: WALLETS.principal })
    expect(report.checks.find((c) => c.id === "daycap")!.status).toBe("fail")
  })

  it("flags a timestamp that disagrees with the block time", async () => {
    const { recordKey } = await attempt(cfg, act("fuel", 1_000, { tsMs: chain.timeMs() - 3_600_000 }))
    const report = await verifyRecord(chain.reader(), recordKey, { expectedPrincipal: WALLETS.principal })
    expect(report.checks.find((c) => c.id === "clock")!.status).toBe("fail")
  })

  it("flags a mandate from an unexpected principal", async () => {
    const { recordKey } = await attempt(cfg, act("fuel", 1_000))
    const report = await verifyRecord(chain.reader(), recordKey, { expectedPrincipal: WALLETS.forger })
    expect(report.checks.find((c) => c.id === "principal")!.status).toBe("fail")
  })
})

describe("atomic batch", () => {
  it("leaves nothing behind when the seal step fails", async () => {
    const agent = chain.writer(WALLETS.agent)
    const predicted = await agent.predictKey()
    const batch = await recordBatch({
      fields: { mandate: cfg.mandateKey, kind: "fuel", amount: 1n, verdict: VERDICT.allowed, reason: REASON.ok, tsMs: chain.timeMs() },
      details: {},
      dataKey,
      retentionDays: 45,
      predicted: { key: ("0x" + "ee".repeat(32)) as `0x${string}`, salt: predicted.salt }, // wrong key: the transfer targets nothing
    })
    await expect(agent.executeBatch(batch)).rejects.toThrow("EntityNotFound")
    expect(await chain.reader().find(recordsByAgent(WALLETS.agent))).toHaveLength(0)
  })
})
