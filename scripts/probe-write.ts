/**
 * Write-path probes behind /arkiv/friction.md. Needs funded Tiramisu keys in .env:
 *   npx tsx --env-file=.env scripts/probe-write.ts
 * Spends a little test GLM. Prints one line per probe and writes scripts/out/probe-write.json.
 */
import { createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { str } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { formatEther, http, type Hash } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { mkdirSync, writeFileSync } from "node:fs"
import { SEAL_ADDRESS } from "../src/core/constants.ts"
import { wsReader } from "../src/core/clients.ts"
import { addressOf, publicClient } from "../src/cli/env.ts"

const pc = publicClient()
// W1–W10 and W12 use the chain object exactly as the SDK ships it (no blockTime): that is what friction F8 measures.
// Tacho's own clients set `blockTime: 2000` (src/core/clients.ts), W11 compares the two.
const stockWallet = (role: "principal" | "agent") => createWalletClient({ chain: tiramisu, transport: http(), account: privateKeyToAccount(process.env[`TACHO_${role.toUpperCase()}_KEY`] as `0x${string}`) })
const principal = stockWallet("principal")
const agent = stockWallet("agent")
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
  return { txHash: hash, gasUsed: r.gasUsed, feeGLM: formatEther(r.gasUsed * r.effectiveGasPrice), block: r.blockNumber }
}
const base = (type: string) => ({ project: str(PROJECT), type: str(type) })

/** Walk the `cause` chain for the revert reason the node returned (a decoded Solidity error name), if any. */
function revertName(err: unknown): string | null {
  for (let c = err as { cause?: unknown; data?: { abiItem?: { name?: string } } } | undefined, i = 0; c && i < 8; c = c.cause as typeof c, i++) {
    if (c.data?.abiItem?.name) return c.data.abiItem.name
  }
  return null
}

/**
 * Run a write that must be rejected. Reports the error text, whether the SDK error carries a `txHash`
 * (the docs: "set when the transaction reached the chain"), and whether the wallet's nonce or balance moved,
 * i.e. whether a rejected write is free (caught by simulation) or costs gas.
 */
async function rejected(id: string, who: "principal" | "agent", run: () => Promise<unknown>) {
  const address = addressOf(who)
  const nonce0 = await pc.getTransactionCount({ address })
  const bal0 = await pc.getBalance({ address })
  try {
    await run()
    log(id, false, { unexpected: "accepted" })
  } catch (err) {
    const nonce1 = await pc.getTransactionCount({ address })
    const bal1 = await pc.getBalance({ address })
    log(`${id} (expected to fail)`, true, {
      error: errText(err),
      errorName: (err as Error).name,
      ownProps: Object.getOwnPropertyNames(err).filter((k) => k !== "stack"),
      reasonOnError: (err as { reason?: unknown }).reason ?? null,
      revertNameInCauseChain: revertName(err),
      txHash: (err as { txHash?: string }).txHash ?? null,
      nonceDelta: nonce1 - nonce0,
      balanceDeltaWei: (bal0 - bal1).toString(),
    })
  }
}

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
  await rejected("W5 creator deletes sealed entity", "agent", () => agent.deleteEntity({ entityKey: pred.key }))

  // W6: a stranger extends it (permissionlessExtension)
  try {
    const x = await principal.extendEntity({ entityKey: pred.key, expires: ExpirationTime.fromHours(3) })
    const after = await pc.getEntity(pred.key)
    log("W6 permissionless extension by a non-owner", true, { returned: x.expiresAt, stored: after.expiresAt, ...(await fee(x.txHash)) })
  } catch (err) {
    log("W6 permissionless extension by a non-owner", false, { error: errText(err) })
  }

  // W7: extending to an earlier expiry
  await rejected("W7 shorter extension", "principal", () => principal.extendEntity({ entityKey: pred.key, expires: ExpirationTime.fromMinutes(5) }))
} catch (err) {
  log("W4 create+seal batch", false, { error: errText(err) })
}

// W8: non-owner extension without the flag; patch on readonly
const own = await principal.createEntity({ payload: jsonToPayload({ probe: 8 }), contentType: "application/json", attributes: base("w8"), expires: ExpirationTime.fromMinutes(10), flags: { readonly: true, permissionlessExtension: false } })
await rejected("W8a non-owner extension without the flag", "agent", () => agent.extendEntity({ entityKey: own.entityKey, expires: ExpirationTime.fromHours(1) }))
await rejected("W8b patch a readonly entity", "principal", () => principal.patchEntity({ entityKey: own.entityKey, set: { type: str("w8b") } }))

// W12: the zero address cannot be the new owner (documented as TransferToZeroAddress); 0x…dEaD can (see W4)
await rejected("W12 transfer to the zero address", "principal", () => principal.changeOwnership({ entityKey: own.entityKey, newOwner: "0x0000000000000000000000000000000000000000" }))

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

// W11: how long a write takes to resolve with the chain definition the SDK ships, versus the same chain
// with `blockTime: 2000` (viem derives the receipt polling interval and cache time from it).
{
  const key = process.env.TACHO_PRINCIPAL_KEY as `0x${string}`
  const mk = (chain: typeof tiramisu) => createWalletClient({ chain, transport: http(), account: privateKeyToAccount(key) })
  const variants = { stock: mk(tiramisu), blockTime2000: mk({ ...tiramisu, blockTime: 2000 } as typeof tiramisu) }
  const ms: Record<string, number[]> = { stock: [], blockTime2000: [] }
  for (let i = 0; i < 4; i++) {
    for (const name of ["stock", "blockTime2000"] as const) {
      const t = performance.now()
      await variants[name].createEntity({ payload: jsonToPayload({ probe: 11, i }), contentType: "application/json", attributes: base("w11"), expires: ExpirationTime.fromMinutes(10) })
      ms[name]!.push(Math.round(performance.now() - t))
    }
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
  log("W11 createEntity latency: stock chain vs blockTime 2000", true, {
    stockMs: ms.stock,
    blockTime2000Ms: ms.blockTime2000,
    stockMedian: median(ms.stock!),
    blockTime2000Median: median(ms.blockTime2000!),
    stockPollingMs: variants.stock.pollingInterval,
    blockTime2000PollingMs: variants.blockTime2000.pollingInterval,
  })
}

mkdirSync("scripts/out", { recursive: true })
writeFileSync("scripts/out/probe-write.json", JSON.stringify({ at: new Date().toISOString(), results }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
process.exit(0)
