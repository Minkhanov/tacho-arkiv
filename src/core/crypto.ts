/**
 * Record details are encrypted before they reach Arkiv: every entity is public, so privacy means
 * ciphertext, never a private flag. AES-256-GCM through WebCrypto, which works the same in
 * Node 20+ and in browsers. The key travels off-chain, for example in a URL fragment, which
 * browsers never send to a server.
 */

export interface SealedEnvelope {
  v: 1
  alg: "A256GCM"
  /** 12-byte nonce, base64url. */
  iv: string
  /** Ciphertext with the 16-byte GCM tag appended, base64url. */
  ct: string
}

export class DecryptError extends Error {
  override name = "DecryptError"
}

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error("WebCrypto is not available in this runtime")
  return s
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new DecryptError("not base64url")
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A fresh random 256-bit data key, base64url-encoded (43 characters). */
export function generateDataKey(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)))
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64Url(keyB64)
  if (raw.length !== 32) throw new DecryptError("data key must be 32 bytes")
  return subtle().importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * Encrypt a JSON value. `aad` binds the ciphertext to the record's public attributes, so
 * details cannot be presented as belonging to a different record.
 */
export async function seal(value: unknown, keyB64: string, aad: string): Promise<SealedEnvelope> {
  const key = await importKey(keyB64)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))),
  )
  return { v: 1, alg: "A256GCM", iv: toBase64Url(iv), ct: toBase64Url(ct) }
}

/** Decrypt an envelope written by `seal`. Throws DecryptError on a wrong key, wrong AAD or tampering. */
export async function unseal<T = unknown>(envelope: unknown, keyB64: string, aad: string): Promise<T> {
  if (!isSealedEnvelope(envelope)) throw new DecryptError("not a sealed envelope")
  const key = await importKey(keyB64)
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: fromBase64Url(envelope.iv) as BufferSource, additionalData: enc.encode(aad) },
      key,
      fromBase64Url(envelope.ct) as BufferSource,
    )
    return JSON.parse(dec.decode(plain)) as T
  } catch (err) {
    if (err instanceof DecryptError) throw err
    throw new DecryptError("cannot decrypt: wrong key, or the record was altered")
  }
}

export function isSealedEnvelope(x: unknown): x is SealedEnvelope {
  if (typeof x !== "object" || x === null) return false
  const e = x as Record<string, unknown>
  return e.v === 1 && e.alg === "A256GCM" && typeof e.iv === "string" && typeof e.ct === "string"
}
