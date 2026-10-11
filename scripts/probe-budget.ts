/**
 * Probes for the public RPC's anonymous query budget (friction.md F9). No key needed, no GLM spent.
 *   npx tsx scripts/probe-budget.ts
 * B1 and B2 read the rate-limit headers of successful calls; B3 only runs while the budget is exhausted (HTTP 429)
 * and shows what viem does with `Retry-After`. Results are merged into scripts/out/probe-budget.json, so run it
 * once with budget left (B1, B2) and, if you hit the limit, again (B3).
 */
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { guardBudget } from "../src/core/clients.ts"
import { TIRAMISU } from "../src/core/constants.ts"

const AGENT = "0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f"
const results: Array<Record<string, unknown>> = []
const log = (id: string, detail: Record<string, unknown>) => {
  results.push({ id, ...detail })
  console.log(`${id} ${JSON.stringify(detail)}`)
}

async function call(method: string, params: unknown[]) {
  const res = await fetch(TIRAMISU.http, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
  const text = await res.text()
  return {
    status: res.status,
    cost: res.headers.get("arkiv-cost"),
    quotaUsedPercent: res.headers.get("arkiv-quota-used-percent"),
    rateLimit: res.headers.get("ratelimit"),
    retryAfter: res.headers.get("retry-after"),
    body: text.length > 160 ? text.slice(0, 160) + "…" : text,
  }
}

const q = (where: string, select: object, extra: object = {}) => call("arkiv_query", [where, { select, ...extra }])
const minimal = { key: true }
const full = { key: true, attributes: true, payload: true, owner: true, creator: true, expiration: true, createdAtBlock: true, lastModifiedAtBlock: true, contentType: true }

// B1: which calls are metered?
const free = await call("eth_blockNumber", [])
const count = await call("arkiv_getEntityCount", [{ query: `$creator = addr(${AGENT})` }])
log("B1 eth_blockNumber and arkiv_getEntityCount", { ethBlockNumber: { status: free.status, cost: free.cost, rateLimit: free.rateLimit }, getEntityCount: { status: count.status, cost: count.cost, rateLimit: count.rateLimit } })

// B2: what does a query cost?
const probeQuery = await q(`$creator = addr(${AGENT})`, minimal, { limit: "0x1" })
if (probeQuery.status === 200) {
  const run = async (label: string, where: string, select: object, extra: object = {}) => {
    const r = await q(where, select, extra)
    return { label, status: r.status, cost: r.cost, rateLimit: r.rateLimit }
  }
  const rows = [
    { label: "select key, limit 1", status: probeQuery.status, cost: probeQuery.cost, rateLimit: probeQuery.rateLimit },
    await run("select key, limit 1, by $key", "$key = key(0xb1aed6899f50f0de4746b67d69b6acd69f7dd95d424b1bf33ba3594f67ba4a5b)", minimal, { limit: "0x1" }),
    await run("select everything, limit 10", `$creator = addr(${AGENT})`, full, { limit: "0xa" }),
    await run("select everything, limit 100", `$creator = addr(${AGENT})`, full, { limit: "0x64" }),
    await run("select key, limit 100", `$creator = addr(${AGENT})`, minimal, { limit: "0x64" }),
  ]
  log("B2 cost of one arkiv_query", { rows })
} else {
  log("B2 cost of one arkiv_query", { skipped: "budget exhausted", status: probeQuery.status, rateLimit: probeQuery.rateLimit, retryAfter: probeQuery.retryAfter, body: probeQuery.body })

  // B3: the budget is exhausted: what does a client do?
  const withTimeout = async <T,>(p: Promise<T>, ms: number): Promise<{ ms: number; outcome: string }> => {
    const t = performance.now()
    const outcome = await Promise.race([
      p.then(() => "resolved", (e: Error) => `threw ${e.name}: ${e.message.split("\n")[0]!.slice(0, 120)}`),
      new Promise<string>((r) => setTimeout(() => r(`no answer after ${ms} ms`), ms)),
    ])
    return { ms: Math.round(performance.now() - t), outcome }
  }
  const stock = createPublicClient({ chain: tiramisu, transport: http() })
  const guarded = createPublicClient({ chain: tiramisu, transport: http(undefined, { fetchFn: guardBudget(), retryCount: 2 }) })
  const { eq } = await import("@arkiv-network/sdk/query")
  const { str } = await import("@arkiv-network/sdk/attr")
  const read = (c: typeof stock) => c.select({ key: true }).where(eq("project", str("tacho/v1"))).limit(1).fetch()
  log("B3 viem default vs guarded transport on HTTP 429", {
    retryAfterSeconds: probeQuery.retryAfter,
    stockClient: await withTimeout(read(stock), 20_000),
    guardedClient: await withTimeout(read(guarded), 20_000),
  })
}

mkdirSync("scripts/out", { recursive: true })
const file = "scripts/out/probe-budget.json"
const prev = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { runs: unknown[] }) : { runs: [] }
prev.runs.push({ at: new Date().toISOString(), results })
writeFileSync(file, JSON.stringify(prev, null, 2))
process.exit(0)
