# Friction report — building Tacho on Arkiv

What got in our way, and what worked as documented, while building Tacho on the Tiramisu testnet. Every item has the versions, what we expected, what happened, how to reproduce it, and what would fix it. Nothing here is hypothetical: each item was hit while building and is reproduced by a script in this repo.

**Environment for every item:** `@arkiv-network/sdk` 0.8.1 · viem 2.56.9 · Node 24.21.0 (Windows 11) · Tiramisu, chain ID 7738577, public RPC without an access key · 9 October 2026.

**Reproduce:** `npx tsx scripts/probe-read.ts 40` (no key needed) and `npx tsx --env-file=.env scripts/probe-write.ts` (funded testnet keys). Item IDs below match the probe labels (P = read, W = write).

## Summary

| # | Surface | Severity for us | Status |
|---|---|---|---|
| F1 | SDK query builder vs docs: "match every entity" | Low — workaround exists | Docs and SDK disagree |
| F2 | `ne()`, `exists()`, `hasType()` exported by the SDK, rejected by the node | Medium — fails at runtime, misleading error | SDK ships operators the network does not support |
| F3 | Filtering on `$createdAt`: three sources disagree, the SDK blocks a query the node accepts | Medium — shaped our schema | Docs, AGENTS.md and SDK disagree |
| F4 | `QueryError` -32002 says "Requested resource not available" for type errors | Low — slows debugging | Error text |
| F5 | `watchEntityEvents` over HTTP polls every ~4.4 s, not every half block; the Live Events page only shows HTTP | Medium — revocation latency is the product | Docs + SDK default |
| F6 | Counting matches: the node supports a filter, the SDK does not expose it | Low | SDK gap |
| F7 | Reading an entity's history (revoked vs expired) has no SDK method; `eth_getLogs` limits are undocumented | Medium — needed for the inspector | SDK + docs gap |
| T1–T3 | Tested paths that worked as documented | — | OK |

---

## F1. A query with no `where()` throws, while the docs say `*` matches every entity

- **Surface:** TypeScript SDK query builder (`select().fetch()`); docs: Fundamentals › Query language, JSON-RPC › Querying data; SDK JSDoc for `select()`.
- **Expected:** Fundamentals says "Use `*` to match every entity". The JSDoc example on `select()` in `dist/index.d.ts` shows `await client.select({ owner: true }).fetch()` with no filter. So `pc.select({ key: true }).limit(1).fetch()` should return the newest entity.
- **Actual:** the builder throws before sending anything:
  `InvalidPredicateError: A query needs at least one filter — the language has no spelling for 'match every entity". Add a where(...) predicate, or narrow by ownedBy(...) / createdBy(...).`
  The node accepts `*` (`pc.query("*", …)` returns entities in ~130 ms). The message is also wrong on its own terms: the language does spell it (`*`), and the quotes are mismatched (`'…"`).
- **Steps:** `scripts/probe-read.ts`, probe P1.
- **Impact on Tacho:** none in the product: we always filter by `project`. It cost time while exploring Tiramisu, which is when people try exactly this.
- **Fix:** either let `select()` with no predicate render `*` (the node supports it), or update the JSDoc example and Fundamentals to say a filter is required, and fix the message.

## F2. `ne()`, `exists()` and `hasType()` are exported and typed, but the network rejects them

- **Surface:** `@arkiv-network/sdk/query` exports `ne`, `exists` and `hasType`, with JSDoc and examples (`ne("status", str("closed"))`, `exists("reviewedBy")`, `hasType("age", "i32")`). Docs › Fundamentals: "There is no `!=` yet."
- **Expected:** if the SDK exports an operator with examples, Tiramisu runs it, or the SDK marks it unsupported, for example with the `UnsupportedOperatorError` class it already has.
- **Actual:** all three compile and are sent. The node rejects each with the same error:
  `QueryError kind=type code=-32002: Query rejected (type, -32002): Requested resource not available.. Query: type != str('x')`
  The same happens for `EXISTS(type)` and `TYPEOF(type) = str`. The documented workaround `not(eq(...))` works.
- **Steps:** `scripts/probe-read.ts`, probe P2.
- **Impact on Tacho:** our forgery query needs "creator is not the agent". `ne()` was the first thing we tried while designing it; after this rejection we use `not(eq("$creator", addr(agent)))` (`forgeriesForMandate` in `src/core/queries.ts`).
- **Fix:** mark `ne`/`exists`/`hasType` `@experimental` with "not supported on Tiramisu yet" in the JSDoc, or throw `UnsupportedOperatorError` client-side until the node supports them. The error is classified as `kind: "type"` although nothing is wrong with the types (see F4).

## F3. Filtering on `$createdAt`: the docs disagree, and the SDK refuses a query the node runs

- **Surface:** SDK predicates on system attributes; Docs › TypeScript SDK › Querying data; Docs › JSON-RPC › Querying data; the challenge's `AGENTS.md`.
- **Expected:** one answer. Instead:
  - TS SDK docs: "`$createdAt`, `$updatedAt`, … carry no index and cannot be filtered on";
  - JSON-RPC docs, synthetic attributes table: `$createdAt` u64 — **Filterable: Yes**;
  - `AGENTS.md` for this challenge: "sort on the client, or range-filter on `$createdAt`".
- **Actual:**
  - `gt("$createdAt", u64(head - 5000n))` throws client-side: `InvalidPredicateError: "$createdAt" is returned in query results but carries no index, so it cannot be filtered on.`;
  - the raw string `$createdAt > u64(<head-5000>)` through `pc.query()` is **accepted** and returns entities (~180 ms).
- **Steps:** `scripts/probe-read.ts`, probe P3.
- **Impact on Tacho:** we wanted "records since the start of the policy day" by block. Not knowing whether a `$createdAt` range is supported, or just unindexed and slow, we added our own `ts_ms` u64 attribute. That costs an attribute, and because the agent writes it, the counterparty must cross-check it against the block time (`clock` check in `src/core/verify.ts`).
- **Fix:** decide whether `$createdAt` ranges are supported. If yes, allow them in the SDK and fix the TS docs. If no, reject them on the node and fix the JSON-RPC docs and `AGENTS.md`.

## F4. Type errors come back as "Requested resource not available"

- **Surface:** node error messages for `QueryError` code -32002 (`kind: "type"`).
- **Expected:** a type error names the type mismatch, for example "`$createdAt` is u64; got i32". The docs tell you to "Tag every value with its type, except bare booleans and bare `i32` numbers".
- **Actual:** `$createdAt > 337993` (bare number, so `i32`) fails with `Query rejected (type, -32002): Requested resource not available.. Query: $createdAt > 337993`. This is the same text as the unsupported-operator rejections in F2, so a type mistake and a missing feature look identical. The doubled period is in the message too.
- **Steps:** `scripts/probe-read.ts`, probe P3 (third line).
- **Fix:** put the attribute's stored type and the literal's type in the message, and keep "unsupported operator" separate from "type mismatch".

## F5. `watchEntityEvents` over HTTP polls every ~4.4 s, not every half block; the Live Events page shows only HTTP

- **Surface:** `watchEntityEvents`; Docs › TypeScript SDK › Live Events; viem `http()` transport; the public RPC.
- **Expected:** Live Events says the watcher "polls the chain" and that `pollingInterval` "Defaults to half a block" (1 s). The SDK passes `pollingInterval: 1000` to viem's `watchEvent`. `AGENTS.md` says a real socket needs a WebSocket transport, but every example on the Live Events page uses `http()`.
- **Actual** (40-second run against Tiramisu):
  - the public RPC rejects filters: `eth_newFilter` → `-32601 the method eth_newFilter does not exist/is not available`, so viem falls back to `eth_blockNumber` + `eth_getLogs` polling;
  - the real cadence is **median 4 409 ms** between `eth_getLogs` calls (min 4 356, max 4 653): 1 `eth_newFilter`, 9 `eth_blockNumber`, 8 `eth_getLogs` in 40 s;
  - the cause is viem's client-level `cacheTime` (default 4 000 ms): `getBlockNumber` is served from cache, so the 1 s poll sees no new block for 4 s. With `cacheTime: 0`, or `pollingInterval: 1000` on the client, the cadence drops to ~2.3 s, one call per block;
  - over a WebSocket transport the same events arrived **2 361 ms earlier** at the median (32 shared events).
- **Steps:** `scripts/probe-read.ts 40`, probes P7, P8 and P9 (P9 runs the same HTTP watcher for 20 s each with the default client, `cacheTime: 0` and `pollingInterval: 1000`).
- **Impact on Tacho:** revocation latency is the product. The agent must stop the moment the principal deletes its mandate. We use a `webSocket()` transport for the agent and the inspector (`src/core/clients.ts`, `web/src/arkiv.ts`); on HTTP with defaults, a revoked agent could keep acting for ~4 s plus a block.
- **Fix:**
  - lead the Live Events page with a `webSocket()` example, as `AGENTS.md` already advises, and state the HTTP fallback cadence honestly;
  - in the SDK, have the watcher's polling path bypass the client's block-number cache (`getBlockNumber({ cacheTime: 0 })`), or set `cacheTime` from `pollingInterval`, so "half a block" holds on HTTP too.

## F6. Counting matches: the node can filter, the SDK cannot

- **Surface:** `getEntityCount()` in the SDK; `arkiv_getEntityCount` in Docs › JSON-RPC.
- **Expected:** the JSON-RPC docs document `arkiv_getEntityCount` with `{ "query"?: string, "block"?: number }`, so the SDK method would accept a query. Instead the TS docs say "To count the entities that match a filter, walk the pages".
- **Actual:** `pc.getEntityCount()` takes no argument and returns the whole chain (1 139). The raw RPC `arkiv_getEntityCount` with `{ query: "project = str('arkiv-chain-indexer-baseload')" }` returns 852 in ~120 ms, in one call.
- **Steps:** `scripts/probe-read.ts`, probe P5.
- **Impact on Tacho:** small. A "records today" counter would be one call instead of a page walk.
- **Fix:** `getEntityCount(query?, { atBlock? })` in the SDK, reusing the builder's predicates.

## F7. An entity's history (revoked or expired?) has no SDK method, and the log limits are undocumented

- **Surface:** SDK (no history read), `watchEntityEvents({ fromBlock })`, raw `eth_getLogs` on the public RPC; Docs › Live Events.
- **Expected:** after a mandate disappears from queries, the inspector must say whether the principal **revoked** it (a delete transaction) or the **lease ran out** (no transaction at all). The docs say "There is no event for [expiry]" and offer only `watchEntityEvents`, which replays from `fromBlock` and then follows the head forever. We expected a bounded read such as `getEntityEvents({ entityKey, fromBlock, toBlock })`.
- **Actual:**
  - there is no such method. We read the log directly: `eth_getLogs` with `address = 0x4400000000000000000000000000000000000044` (found only in the SDK source, `src/consts.ts`) and `topics = [null, entityKey]`, because every entity event indexes the key as its first topic. This works: about 100 ms for one entity;
  - the limits are not in the docs. Over 100 000 blocks: `-32602 query exceeds max block range 100000`. Without a topic filter over 50 000 blocks: `-32602 query exceeds max results 20000, retry with the range 293739-304569`. The second message is helpful;
  - with viem's `getLogs({ events: ENTITY_EVENTS_ABI, args: { entityKey } })`, the `args` are silently not applied for a multi-event filter. The response for 10 000 blocks then exceeds viem's body limit. This one is viem's behaviour, not Arkiv's, but it is the first thing an SDK user will try with the exported `ENTITY_EVENTS_ABI`.
- **Steps:** `scripts/probe-read.ts`, probe P10. Our implementation: `src/core/history.ts` (`lifecycle()`, chunked by 100 000 blocks).
- **Impact on Tacho:** the "revoked at block N" and "lease ran out at block N" badges, and the heartbeat ticks on the tachograph disc, come from this read.
- **Fix:** a `getEntityHistory(key, { fromBlock, toBlock })` on the public client that returns decoded lifecycle events; document the operation address, the topic layout and the `eth_getLogs` limits on the JSON-RPC page.

---

## Tested paths that worked as documented

- **T1. Page size limit.** `limit(500)` fails in the SDK before sending, with a clear message ("limit 500 exceeds the node maximum of 200. Page through the results with the cursor instead."). The raw RPC returns `-32602` with the same text. Matches the docs. (P4)
- **T2. `atBlock` history.** Reads at head − 43 200 (one day) and head − 302 400 (seven days) succeed in ~150 ms. The docs say the node keeps "a limited history"; on Tiramisu we did not reach the limit within the chain's lifetime: a block near genesis answers with an empty result, not an error. Tacho's counterparty check relies on `atBlock` to ask "was the mandate alive when this record landed?" (P6)
- **T3. `$creator` filters.** `createdBy()` matches regardless of address case. `not(eq("$creator", addr(x)))` works and renders as `NOT $creator = addr(…)`. `eq("$key", key(k))` with `atBlock` returns a single entity as of that block. (`test/queries.test.ts` checks that our query strings match the SDK builder's `toString()` byte for byte.)
