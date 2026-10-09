/**
 * Read-only probes behind /arkiv/friction.md. No key needed:
 *   npx tsx scripts/probe-read.ts [seconds-to-watch]
 * Each probe prints what the docs say, what the SDK/node did, and the raw evidence.
 */
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { str, u64 } from "@arkiv-network/sdk/attr"
import { eq, exists, gt, hasType, ne, not } from "@arkiv-network/sdk/query"
import { http, webSocket } from "viem"
import { readFileSync } from "node:fs"

const RPC = "https://rpc.tiramisu.db-chain.testnet.arkiv.network"
const WATCH_SECONDS = Number(process.argv[2] ?? 30)
const sdkVersion = JSON.parse(readFileSync(new URL("../node_modules/@arkiv-network/sdk/package.json", import.meta.url), "utf8")).version
const viemVersion = JSON.parse(readFileSync(new URL("../node_modules/viem/package.json", import.meta.url), "utf8")).version
console.log(`@arkiv-network/sdk ${sdkVersion} · viem ${viemVersion} · node ${process.version} · ${new Date().toISOString()}`)

const pc = createPublicClient({ chain: tiramisu, transport: http() })
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  return r.json() as Promise<{ result?: unknown; error?: { code: number; message: string } }>
}
async function probe(label: string, fn: () => Promise<unknown>) {
  const t = performance.now()
  try {
    const r = await fn()
    console.log(`  OK   ${label} → ${summarise(r)} (${Math.round(performance.now() - t)} ms)`)
  } catch (err: any) {
    console.log(`  ERR  ${label} → ${err?.constructor?.name}${err?.kind ? ` kind=${err.kind}` : ""}${err?.code ? ` code=${err.code}` : ""}: ${String(err?.shortMessage ?? err?.message).split("\n")[0]}`)
  }
}
const summarise = (r: any) => (r?.entities ? `${r.entities.length} entities` : r?.result !== undefined ? JSON.stringify(r.result).slice(0, 80) : r?.error ? `error ${r.error.code} ${r.error.message}` : JSON.stringify(r)?.slice(0, 80))

const head = await pc.getBlockNumber()
console.log(`head block ${head}\n`)

console.log("P1  query with no filter (docs: '*' matches every entity)")
await probe("SDK select().limit(1).fetch()", () => pc.select({ key: true }).limit(1).fetch())
await probe("SDK query('*')", () => pc.query("*", { select: { key: true }, limit: 1 }))

console.log("\nP2  ne(), exists() and hasType() are exported by @arkiv-network/sdk/query")
await probe("ne('type', str('x'))", () => pc.select({ key: true }).where(ne("type", str("x"))).limit(1).fetch())
await probe("exists('type')", () => pc.select({ key: true }).where(exists("type")).limit(1).fetch())
await probe("hasType('type', 'str')", () => pc.select({ key: true }).where(hasType("type", "str")).limit(1).fetch())
await probe("not(eq('type', str('x'))) (the documented workaround)", () => pc.select({ key: true }).where(not(eq("type", str("x")))).limit(1).fetch())

console.log("\nP3  range filter on $createdAt (TS docs: not indexed; JSON-RPC docs: filterable; AGENTS.md: range-filter on $createdAt)")
await probe("SDK gt('$createdAt', u64(head-5000))", () => pc.select({ key: true }).where(gt("$createdAt", u64(head - 5000n))).limit(1).fetch())
await probe("raw '$createdAt > u64(head-5000)'", () => pc.query(`$createdAt > u64(${head - 5000n})`, { select: { key: true }, limit: 1 }))
await probe("raw '$createdAt > head-5000' (bare number = i32)", () => pc.query(`$createdAt > ${head - 5000n}`, { select: { key: true }, limit: 1 }))

console.log("\nP4  page size above the documented maximum of 200")
await probe("SDK limit(500)", () => pc.select({ key: true }).where(eq("project", str("arkiv-chain-indexer-baseload"))).limit(500).fetch())
await probe("raw arkiv_query limit 0x1f4", () => rpc("arkiv_query", ["$expiresAt > u64(0)", { limit: "0x1f4" }]).then((r: any) => (r.result ? { entities: r.result.data } : r)))

console.log("\nP5  counting matches (SDK getEntityCount() takes no filter; JSON-RPC documents { query })")
await probe("SDK getEntityCount()", () => pc.getEntityCount())
await probe("raw arkiv_getEntityCount {query}", () => rpc("arkiv_getEntityCount", [{ query: `project = str('arkiv-chain-indexer-baseload')` }]))

console.log("\nP6  how far back atBlock reaches")
for (const back of [43_200n, 302_400n, head - 1n]) {
  await probe(`atBlock(head-${back})`, () => pc.query("*", { select: { key: true }, atBlock: head - back, limit: 1 }))
}

console.log("\nP7  HTTP log filters (watchEntityEvents over http())")
await probe("raw eth_newFilter", () => rpc("eth_newFilter", [{ address: "0x4400000000000000000000000000000000000044" }]))

console.log("\nP10 entity history from event logs (eth_getLogs, topics [any event, entityKey]) and its limits")
{
  const sample = (await pc.query("*", { select: { key: true, createdAt: true }, limit: 1, atBlock: head - 3000n })) as unknown as { entities: Array<{ key: string; createdAt: bigint }> }
  const sk = sample.entities[0]
  const hex = (n: bigint) => "0x" + n.toString(16)
  const ARKIV = "0x4400000000000000000000000000000000000044"
  if (sk) {
    await probe(`eth_getLogs by entityKey over ${head - sk.createdAt} blocks`, () => rpc("eth_getLogs", [{ address: ARKIV, fromBlock: hex(sk.createdAt), toBlock: "latest", topics: [null, sk.key] }]).then((r: any) => (r.result ? { entities: r.result } : r)))
    await probe("eth_getLogs by entityKey over 150 000 blocks", () => rpc("eth_getLogs", [{ address: ARKIV, fromBlock: hex(head - 150_000n), toBlock: "latest", topics: [null, sk.key] }]))
  }
  await probe("eth_getLogs unfiltered over 50 000 blocks", () => rpc("eth_getLogs", [{ address: ARKIV, fromBlock: hex(head - 50_000n), toBlock: "latest" }]).then((r: any) => (r.result ? { entities: r.result } : r)))
}

console.log(`\nP8  watchEntityEvents: HTTP vs WebSocket for ${WATCH_SECONDS} s (docs: HTTP polls every half block = 1 s)`)
const calls: Array<{ t: number; m: string }> = []
const httpClient = createPublicClient({
  chain: tiramisu,
  transport: http(undefined, {
    onFetchRequest: async (req) => {
      try {
        const b = JSON.parse(await req.clone().text())
        for (const x of Array.isArray(b) ? b : [b]) calls.push({ t: performance.now(), m: x.method })
      } catch {
        /* ignore */
      }
    },
  }),
})
const wsClient = createPublicClient({ chain: tiramisu, transport: webSocket() })
const seen = new Map<string, { http?: number; ws?: number }>()
const mark = (via: "http" | "ws") => (e: { transactionHash: string; logIndex: number }) => {
  const k = `${e.transactionHash}:${e.logIndex}`
  const v = seen.get(k) ?? {}
  v[via] ??= performance.now()
  seen.set(k, v)
}
const t0 = performance.now()
const u1 = httpClient.watchEntityEvents({ onEvent: mark("http"), onError: (e) => console.log("  http error", e.message.split("\n")[0]) })
const u2 = wsClient.watchEntityEvents({ onEvent: mark("ws"), onError: (e) => console.log("  ws error", e.message.split("\n")[0]) })
await new Promise((r) => setTimeout(r, WATCH_SECONDS * 1000))
u1()
u2()
const byMethod: Record<string, number> = {}
for (const c of calls) byMethod[c.m] = (byMethod[c.m] ?? 0) + 1
const polls = calls.filter((c) => c.m === "eth_getLogs").map((c) => c.t)
const gaps = polls.slice(1).map((t, i) => t - polls[i]!).sort((a, b) => a - b)
const both = [...seen.values()].filter((v) => v.http !== undefined && v.ws !== undefined).map((v) => v.http! - v.ws!).sort((a, b) => a - b)
const med = (a: number[]) => (a.length ? Math.round(a[Math.floor(a.length / 2)]!) : NaN)
console.log(`  HTTP requests in ${Math.round((performance.now() - t0) / 1000)} s: ${JSON.stringify(byMethod)}`)
console.log(`  eth_getLogs cadence: median ${med(gaps)} ms, min ${Math.round(gaps[0] ?? NaN)} ms, max ${Math.round(gaps.at(-1) ?? NaN)} ms`)
console.log(`  events: http ${[...seen.values()].filter((v) => v.http).length}, ws ${[...seen.values()].filter((v) => v.ws).length}; WebSocket first by median ${med(both)} ms over ${both.length} shared events`)

console.log("\nP9  why HTTP polls slower than pollingInterval: viem's client cacheTime (20 s per setting)")
for (const [label, extra] of [
  ["default client", {}],
  ["client cacheTime: 0", { cacheTime: 0 }],
  ["client pollingInterval: 1000", { pollingInterval: 1000 }],
] as const) {
  const ts: number[] = []
  const c = createPublicClient({
    chain: tiramisu,
    ...extra,
    transport: http(undefined, {
      onFetchRequest: async (req) => {
        try {
          const b = JSON.parse(await req.clone().text())
          for (const x of Array.isArray(b) ? b : [b]) if (x.method === "eth_getLogs") ts.push(performance.now())
        } catch {
          /* ignore */
        }
      },
    }),
  })
  const un = c.watchEntityEvents({ onEvent: () => undefined, onError: () => undefined })
  await new Promise((r) => setTimeout(r, 20_000))
  un()
  const g = ts.slice(1).map((t, i) => t - ts[i]!).sort((a, b) => a - b)
  console.log(`  ${label.padEnd(30)} eth_getLogs calls ${ts.length}, median gap ${med(g)} ms`)
}
process.exit(0)
