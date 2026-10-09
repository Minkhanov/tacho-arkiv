import { describe, expect, it } from "vitest"
import { DecryptError, fromBase64Url, generateDataKey, isSealedEnvelope, seal, toBase64Url, unseal } from "../src/core/crypto.ts"

const details = { vehicle: "TRK-07", station: "Station 12 (synthetic)", liters: 210, rationale: "Refuel before the M7 leg." }

describe("sealed envelopes", () => {
  it("round-trips JSON with the right key and AAD", async () => {
    const key = generateDataKey()
    const env = await seal(details, key, "aad-1")
    expect(isSealedEnvelope(env)).toBe(true)
    expect(await unseal(env, key, "aad-1")).toEqual(details)
  })

  it("never leaks plaintext into the envelope", async () => {
    const env = await seal(details, generateDataKey(), "aad")
    expect(JSON.stringify(env)).not.toMatch(/TRK-07|Station|rationale/)
  })

  it("uses a fresh nonce for every seal", async () => {
    const key = generateDataKey()
    const a = await seal(details, key, "aad")
    const b = await seal(details, key, "aad")
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it("fails closed on a wrong key", async () => {
    const env = await seal(details, generateDataKey(), "aad")
    await expect(unseal(env, generateDataKey(), "aad")).rejects.toBeInstanceOf(DecryptError)
  })

  it("fails closed when the public attributes (AAD) do not match", async () => {
    const key = generateDataKey()
    const env = await seal(details, key, "record|fuel|1240000")
    await expect(unseal(env, key, "record|fuel|9000000")).rejects.toBeInstanceOf(DecryptError)
  })

  it("fails closed on a tampered ciphertext", async () => {
    const key = generateDataKey()
    const env = await seal(details, key, "aad")
    const ct = fromBase64Url(env.ct)
    ct[0] = ct[0]! ^ 1
    await expect(unseal({ ...env, ct: toBase64Url(ct) }, key, "aad")).rejects.toBeInstanceOf(DecryptError)
  })

  it("rejects keys that are not 32 bytes and non-envelopes", async () => {
    await expect(seal(details, toBase64Url(new Uint8Array(16)), "aad")).rejects.toBeInstanceOf(DecryptError)
    await expect(unseal({ hello: 1 }, generateDataKey(), "aad")).rejects.toBeInstanceOf(DecryptError)
  })

  it("encodes base64url without padding and decodes it back", () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2])
    const text = toBase64Url(bytes)
    expect(text).not.toMatch(/[+/=]/)
    expect([...fromBase64Url(text)]).toEqual([...bytes])
    expect(generateDataKey()).toHaveLength(43)
  })
})
