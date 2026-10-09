import { describe, expect, it } from "vitest"
import { jsonToPayload } from "@arkiv-network/sdk"
import { addr, key, str, u64 } from "@arkiv-network/sdk/attr"
import { PROJECT, REASON, SEAL_ADDRESS, VERDICT } from "../src/core/constants.ts"
import { generateDataKey, unseal } from "../src/core/crypto.ts"
import { mandateCreate, parseMandate, parseRecord, recordAad, recordBatch, SchemaError, type EntityLike, type Hex, type RecordFields } from "../src/core/entities.ts"
import { demoPolicy } from "../src/core/policy.ts"
import { WALLETS } from "./fake-arkiv.ts"

const MANDATE = ("0x" + "ab".repeat(32)) as Hex
const RECORD = ("0x" + "cd".repeat(32)) as Hex

describe("mandateCreate", () => {
  const p = mandateCreate({ agent: WALLETS.agent, policy: demoPolicy(), issuedMs: 1_791_534_000_000 })

  it("puts what is queried in typed attributes and the policy in the payload", () => {
    expect(p.attributes).toEqual({
      project: str(PROJECT),
      type: str("mandate"),
      agent: addr(WALLETS.agent),
      issued_ms: u64(1_791_534_000_000n),
    })
    expect(JSON.parse(new TextDecoder().decode(p.payload)).kinds).toEqual(["fuel", "toll"])
    expect(p.contentType).toBe("application/json")
  })

  it("is readonly, owner-extended only, and lives one lease (450 blocks for 15 minutes)", () => {
    expect(p.flags).toEqual({ readonly: true, permissionlessExtension: false })
    expect(p.expires.minLifetime).toBe(450n)
  })
})

describe("recordBatch", () => {
  const fields: RecordFields = { mandate: MANDATE, kind: "fuel", amount: 1_240_000n, verdict: VERDICT.allowed, reason: REASON.ok, tsMs: 1_791_534_000_000 }

  it("creates the record and seals it in the same atomic batch", async () => {
    const dataKey = generateDataKey()
    const b = await recordBatch({ fields, details: { vehicle: "TRK-07" }, dataKey, retentionDays: 45, predicted: { key: RECORD, salt: 42n } })
    expect(b.creates).toHaveLength(1)
    const c = b.creates![0]!
    expect(c.salt).toBe(42n)
    expect(c.flags).toEqual({ readonly: true, permissionlessExtension: true })
    expect(c.expires.minLifetime).toBe(45n * 43_200n)
    expect(b.ownershipChanges).toEqual([{ entityKey: RECORD, newOwner: SEAL_ADDRESS }])
    expect(Object.keys(c.attributes!).sort()).toEqual(["amount", "kind", "mandate", "project", "reason", "ts_ms", "type", "verdict"])
    expect(c.attributes!.amount).toEqual(u64(1_240_000n))
    expect(c.attributes!.mandate).toEqual(key(MANDATE))
    const env = JSON.parse(new TextDecoder().decode(c.payload))
    expect(await unseal(env, dataKey, recordAad(fields))).toEqual({ vehicle: "TRK-07" })
  })
})

const entity = (over: Partial<EntityLike> & { attributes: EntityLike["attributes"] }): EntityLike => ({
  key: RECORD,
  creator: WALLETS.agent,
  owner: SEAL_ADDRESS,
  createdAt: 100n,
  expiresAt: 200n,
  creationFlags: { readonly: true, permissionlessExtension: true },
  payload: jsonToPayload({ v: 1, alg: "A256GCM", iv: "AA", ct: "AA" }),
  ...over,
})

const recordAttrs = {
  project: { type: "str", value: PROJECT },
  type: { type: "str", value: "record" },
  mandate: { type: "key", value: MANDATE },
  kind: { type: "str", value: "fuel" },
  amount: { type: "u64", value: 1_240_000n },
  verdict: { type: "str", value: "allowed" },
  reason: { type: "str", value: "ok" },
  ts_ms: { type: "u64", value: 1_791_534_000_000n },
}

describe("parsers", () => {
  it("parses a sealed record and exposes its creator as the writer", () => {
    const r = parseRecord(entity({ attributes: recordAttrs }))
    expect(r.writer).toBe(WALLETS.agent)
    expect(r.sealed).toBe(true)
    expect(r.amount).toBe(1_240_000n)
    expect(r.envelope?.alg).toBe("A256GCM")
  })

  it("rejects entities from another namespace or with mistyped attributes", () => {
    expect(() => parseRecord(entity({ attributes: { ...recordAttrs, project: { type: "str", value: "other" } } }))).toThrow(SchemaError)
    // a number stored as a string would silently break range queries: refuse it
    expect(() => parseRecord(entity({ attributes: { ...recordAttrs, amount: { type: "str", value: "1240000" } } }))).toThrow(SchemaError)
    expect(() => parseRecord(entity({ attributes: { ...recordAttrs, verdict: { type: "str", value: "maybe" } } }))).toThrow(SchemaError)
  })

  it("parses a mandate and validates its public policy", () => {
    const create = mandateCreate({ agent: WALLETS.agent, policy: demoPolicy(), issuedMs: 1 })
    const m = parseMandate(
      entity({
        creator: WALLETS.principal,
        owner: WALLETS.principal,
        payload: create.payload,
        attributes: Object.fromEntries(Object.entries(create.attributes!).map(([k, v]) => [k, v as { type: string; value: unknown }])),
      }),
    )
    expect(m.principal).toBe(WALLETS.principal)
    expect(m.agent).toBe(WALLETS.agent)
    expect(m.policy.perDayCap).toBe(4_000_000n)
  })
})
