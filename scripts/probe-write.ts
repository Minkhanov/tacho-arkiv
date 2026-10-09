/**
 * Write-path probes behind /arkiv/friction.md. Needs funded Tiramisu keys in .env:
 *   npx tsx --env-file=.env scripts/probe-write.ts
 * Spends a little test GLM. Prints one line per probe and writes scripts/out/probe-write.json.
 */
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { str } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { formatEther, type Hash } from "viem"
import { mkdirSync, writeFileSync } from "node:fs"
import { SEAL_ADDRESS } from "../src/core/constants.ts"
import { wsReader } from "../src/core/clients.ts"
import { addressOf, publicClient, walletOf } from "../src/cli/env.ts"

const pc = publicClient()
const principal = walletOf("principal")
const agent = walletOf("agent")
const results: Array<Record<string, unknown>> = []
const PROJECT = "tacho-probe/v1"

function log(id: string, ok: boolean, detail: Record<string, unknown>) {
  results.push({ id, ok, ...detail })
  console.log(`${ok ? "OK " : "ERR"} ${id} ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`)
}
const errText = (e: unknown) => {
  const err = e as { name?: string; shortMessage?: string; message?: string; details?: string }
  return `${err.name}: ${(err.shortMessage ?? err.message ?? "").split("\n")[0]}${err.details ? ` | details: ${err.details}` : ""}`
}
async function fee(hash: Hash) {
  const r = await pc.getTransactionReceipt({ hash })
  return { gasUsed: r.gasUsed, feeGLM: formatEther(r.gasUsed * r.effectiveGasPrice), block: r.blockNumber }
}
const base = (type: string) => ({ project: str(PROJECT), type: str(type) })

// W1: a plain GLM transfer between two wallets
try {
  const hash = await principal.sendTransaction({ to: addressOf("forger"), value: 10n ** 15n } as never)
  const r = await pc.waitForTransactionReceipt({ hash })
  log("W1 plain GLM transfer", r.status === "success", { status: r.status, ...(await fee(hash)) })
} catch (e) {
  log("W1 plain GLM transfer", false, { error: errText(e) })
}

// W2: createEntity's returned expiresAt vs the entity's stored expiry
const t0 = performance.now()
const created = await principal.createEntity({ payload: jsonToPayload({ probe: 2 }), contentType: "application/json", attributes: base("w2"), expires: ExpirationTime.fromMinutes(10) })
const tCreated = performance.now()
let visibleMs = -1
for (let i = 0; i < 60; i++) {
  try {
    await pc.getEntity(created.entityKey)
    visibleMs = Math.round(performance.now() - tCreated)
    break
  } catch {
    await new Promise((r) => setTimeout(r, 250))
  }
}
const stored = await pc.getEntity(created.entityKey)
log("W2 createEntity expiresAt", true, {
  returned: created.expiresAt,
  stored: stored.expiresAt,
  diffBlocks: stored.expiresAt - created.expiresAt,
  createdAt: stored.createdAt,
  createMs: Math.round(tCreated - t0),
  visibleAfterMs: visibleMs,
  ...(await fee(created.txHash)),
})

// W3: query visibility right after the write resolves
const q = await pc.select({ key: true }).where(eq("project", str(PROJECT)), eq("type", str("w2"))).createdBy(addressOf("principal")).fetch()
log("W3 query sees the new entity immediately", q.entities.some((e) => e.key === created.entityKey), { found: q.entities.length })

// W4: predict a key, create + hand to the seal address in one batch
const [pred] = await pc.predictEntityKeys({ owner: addressOf("agent"), count: 1 })
try {
  const b = await agent.executeBatch({
    creates: [{ payload: jsonToPayload({ probe: 4 }), contentType: "application/json", attributes: base("w4"), expires: ExpirationTime.fromHours(1), flags: { readonly: true, permissionlessExtension: true }, salt: pred.salt }],
    ownershipChanges: [{ entityKey: pred.key, newOwner: SEAL_ADDRESS }],
  })
  const e = await pc.getEntity(b.createdEntities[0]!)
  log("W4 create+seal batch", e.owner.toLowerCase() === SEAL_ADDRESS.toLowerCase() && b.createdEntities[0] === pred.key, {
    predicted: pred.key,
    minted: b.createdEntities[0],
    owner: e.owner,
    creator: e.creator,
    flags: e.creationFlags,
    ...(await fee(b.txHash)),
  })

  // W5: the creator tries to delete the sealed entity
  try {
    await agent.deleteEntity({ entityKey: pred.key })
    log("W5 creator deletes sealed entity", false, { unexpected: "delete succeeded" })
  } catch (err) {
    log("W5 creator deletes sealed entity (expected to fail)", true, { error: errText(err) })
  }

  // W6: a stranger extends it (permissionlessExtension)
  try {
    const x = await principal.extendEntity({ entityKey: pred.key, expires: ExpirationTime.fromHours(3) })
    const after = await pc.getEntity(pred.key)
    log("W6 permissionless extension by a non-owner", true, { returned: x.expiresAt, stored: after.expiresAt, ...(await fee(x.txHash)) })
  } catch (err) {
    log("W6 permissionless extension by a non-owner", false, { error: errText(err) })
  }

  // W7: extending to an earlier expiry
  try {
    await principal.extendEntity({ entityKey: pred.key, expires: ExpirationTime.fromMinutes(5) })
    log("W7 shorter extension", false, { unexpected: "accepted" })
  } catch (err) {
    log("W7 shorter extension (expected to fail)", true, { error: errText(err) })
  }
} catch (err) {
  log("W4 create+seal batch", false, { error: errText(err) })
}

// W8: non-owner extension without the flag; patch on readonly
const own = await principal.createEntity({ payload: jsonToPayload({ probe: 8 }), contentType: "application/json", attributes: base("w8"), expires: ExpirationTime.fromMinutes(10), flags: { readonly: true, permissionlessExtension: false } })
try {
  await agent.extendEntity({ entityKey: own.entityKey, expires: ExpirationTime.fromHours(1) })
  log("W8a non-owner extension without the flag", false, { unexpected: "accepted" })
} catch (err) {
  log("W8a non-owner extension without the flag (expected to fail)", true, { error: errText(err) })
}
try {
  await principal.patchEntity({ entityKey: own.entityKey, set: { type: str("w8b") } })
  log("W8b patch a readonly entity", false, { unexpected: "accepted" })
} catch (err) {
  log("W8b patch a readonly entity (expected to fail)", true, { error: errText(err) })
}

// W9: WebSocket latency of EntityDeleted
const ws = wsReader()
let seenAt = 0
const un = ws.watchEntityEvents({ onEntityDeleted: (e) => (e.entityKey === own.entityKey ? (seenAt = performance.now()) : undefined) })
await new Promise((r) => setTimeout(r, 1500))
const d0 = performance.now()
const del = await principal.deleteEntity({ entityKey: own.entityKey })
const d1 = performance.now()
for (let i = 0; i < 40 && !seenAt; i++) await new Promise((r) => setTimeout(r, 100))
un()
log("W9 WebSocket EntityDeleted", seenAt > 0, { deleteResolvedMs: Math.round(d1 - d0), eventAfterSendMs: seenAt ? Math.round(seenAt - d0) : null, eventVsResolveMs: seenAt ? Math.round(seenAt - d1) : null, ...(await fee(del.txHash)) })

// W10: odd-second lifetime is rejected client-side
try {
  ExpirationTime.fromSeconds(901)
  log("W10 fromSeconds(901)", false, { unexpected: "accepted" })
} catch (err) {
  log("W10 fromSeconds(901) (expected to fail client-side)", true, { error: errText(err) })
}

mkdirSync("scripts/out", { recursive: true })
writeFileSync("scripts/out/probe-write.json", JSON.stringify({ at: new Date().toISOString(), results }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
process.exit(0)
