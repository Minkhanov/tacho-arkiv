# Friction report — building Tacho on Arkiv

What got in our way, and what worked as documented, while building Tacho on the Tiramisu testnet. Every item has the versions, what we expected, what happened, how to reproduce it, and what would fix it. Nothing here is hypothetical: each item was hit while building and is reproduced by a script in this repo.

**Environment for every item:** `@arkiv-network/sdk` 0.8.1 · viem 2.56.9 · Node 24.21.0 (Windows 11) · Tiramisu, chain ID 7738577, public RPC without an access key · read probes 9 October 2026, write probes and the budget probe 11 October 2026.

**Reproduce:** `npx tsx scripts/probe-read.ts 40` (no key needed), `npx tsx --env-file=.env scripts/probe-write.ts` (funded testnet keys) and `npx tsx scripts/probe-budget.ts` (no key needed). Item IDs below match the probe labels (P = read, W = write, B = budget).

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
| F8 | The SDK's `tiramisu` chain has no `blockTime`: viem polls receipts every 4 s, so every write takes ~4.8 s instead of ~3 s | Medium — also the root cause of F5 | SDK chain definition |
| F9 | The public RPC meters `arkiv_query` for anonymous callers (100 units each, 10 000 per window per IP); not in the docs, and viem sleeps through the 48-minute `Retry-After` so an app just hangs | High for a static app that reads from visitors' browsers | Docs + client default |
| F10 | `EntityMutationError` has no machine-readable reason; the decoded name is two levels down the `cause` chain | Low | SDK |
| T1–T9 | Tested paths that worked as documented | — | OK |

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
  - in the SDK, have the watcher's polling path bypass the client's block-number cache (`getBlockNumber({ cacheTime: 0 })`), or set `cacheTime` from `pollingInterval`, so "half a block" holds on HTTP too;
  - or, for this and F8 at once, add `blockTime: 2000` to the `tiramisu` chain definition: viem then derives a 1 s polling interval and a 1 s cache.

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

## F8. Writes take ~4.8 s because the SDK's `tiramisu` chain has no `blockTime`

- **Surface:** the `tiramisu` chain object exported by `@arkiv-network/sdk/chains`; viem client defaults; every write method (`createEntity`, `extendEntity`, `deleteEntity`, `executeBatch`), which all end in `walletClient.waitForTransactionReceipt({ hash })` with no options.
- **Expected:** Fundamentals: "Sequencer produces blocks (2 s block time)". A write that lands in the next block returns in about 2–3 s.
- **Actual** (probes W2, W9, W11; Tiramisu, 11 October 2026):
  - `createEntity` with the chain object as shipped resolves after a **median of 4 844 ms** (4 769–4 974, four calls; W2 alone: 4 937 ms). The same call with `{ ...tiramisu, blockTime: 2000 }` resolves after a **median of 2 981 ms** (1 966–4 068, four calls, alternated with the first set). The fixed variant is not constant: a transaction lands in the next 2 s block and the 1 s poll finds it within a second of that;
  - the cause is in viem: `pollingInterval` defaults to `min(max(blockTime / 2, 500), 4000)`, and without a `blockTime` viem assumes 12 s. The client reports `pollingInterval` 4000 ms with the shipped chain and 1000 ms with `blockTime: 2000`. The transaction is in a block after about 2 s; the receipt poll only looks again at the next 4 s tick;
  - a WebSocket subscription sees the result earlier than the awaited call returns: in W9 the `EntityDeleted` event arrived 1 552 ms after the send, and `deleteEntity()` resolved at 4 959 ms, so the event came 3.4 s before the promise;
  - the same missing `blockTime` is the root cause of F5: viem's `cacheTime` defaults to `pollingInterval`, which is the 4 s cache that stretched the "half block" watcher to 4.4 s.
- **Steps:** `scripts/probe-write.ts`, probes W2, W9 and W11 (W11 alternates the two chain objects, four calls each).
- **Impact on Tacho:** in the first demo run the six agent attempts were 5.4 s apart on average (07:47:35 to 07:48:02, `demo/state.json`). We now build every CLI client from `TIRAMISU_CHAIN = { ...tiramisu, blockTime: 2000 }` (`src/core/clients.ts`); in the next two runs the attempts were 3.6 s and 4.0 s apart (08:40:06 to 08:40:24, 09:40:10 to 09:40:30), each attempt also doing three reads.
- **Fix:** add `blockTime: 2000` to the chain definition in the SDK. Every consumer then gets 1 s receipt polling and a 1 s block-number cache, which also fixes F5 on HTTP. One line, no API change.

## F9. The public RPC has an anonymous query budget that is not in the docs, and viem turns it into a silent hang

- **Surface:** the public RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network` for `arkiv_query`; Docs › Start here › Access Keys; viem's HTTP retry.
- **Expected:** Access Keys says "You do not need a key to try Arkiv. The public RPC works without one, at the default rate limit", and that keys have "a monthly quota, measured in cost units". We expected a documented limit that a small demo does not reach, and an error when it does.
- **Actual:**
  - there is a second, hidden limit besides the per-minute one. `eth_blockNumber` and `arkiv_getEntityCount` answer with `ratelimit: limit=600, remaining=…, reset=60` and no cost. `arkiv_query` is metered: a minimal query (`select key`, `limit 1`) answers with `arkiv-cost: 100`, and anonymous callers have **10 000 units** per window. When it is gone, every `arkiv_query` returns `HTTP 429` with `{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}`, `ratelimit: limit=10000, remaining=0, reset=2866` and `retry-after: 2866` (48 minutes). Our test machine reached it about twelve minutes after its first query, while running the write probes three times, one integration run and one demo;
  - none of these numbers, the 429 body, the `ANON_COST_LIMITED` code or the price of an operation is in the docs;
  - **the client hides it.** viem's retry waits for `Retry-After` (`utils/buildRequest.js`: `Number.parseInt(retryAfter) * 1000`), so with the SDK's default `http()` transport a query during exhaustion produces no answer and no error: probe B3 waited 20 s with nothing, because the call is asleep for 2 532 s. A static app shows its spinner forever. The first version of our inspector did exactly that on the record page, which is how we found this;
  - cost per operation (probe B2, run at the start of a new window): a flat **100 units** for every shape we tried: `select key` with `limit 1`; the same by `$key`; a full entity (attributes, payload, owner, creator, expiry) with `limit 10` and with `limit 100`; `select key` with `limit 100`. The result sets were small (the agent had a few dozen entities), so we cannot say whether a full page of 200 rows costs more. At 100 per query an anonymous IP gets about 100 queries per window. `arkiv_getEntityCount` and the `eth_*` calls are not charged; they share a separate 600-per-minute counter.
- **Steps:** `npx tsx scripts/probe-budget.ts` (B1 and B2 read the headers of successful calls; B3 runs only while the budget is exhausted and compares the stock transport with one that fails fast). Raw: `curl -si -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["$creator = addr(0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f)",{"select":{"key":true},"limit":"0x1"}]}' https://rpc.tiramisu.db-chain.testnet.arkiv.network` and read `arkiv-cost` and `ratelimit`.
- **Impact on Tacho (high):** the inspector is a static page that reads the public RPC from every visitor's browser, so a judge's own IP pays for a page load. One agent page costs 11 queries, 1 100 units (one live and two past mandates); a record check is 4 queries, 400 units; the whole `npm run demo` is 28 queries, 2 800 units, so one anonymous IP can run it three times an hour. We changed four things: no timer-driven refresh (the 30 s poll would have used the budget in minutes), at most four mandates per page, a visible error that says when the budget renews, and `?apikey=<key>` in the link for a visitor's own free Hub key (the key stays in the URL fragment, and only the official RPC host is ever used, so a crafted link cannot point the inspector at a server that invents records). The CLI prints the units each run used.
- **Fix:**
  - document the anonymous budget: units per window per IP, the 429 body, and a price list of operations (`select key limit 1` = 100; what does a page of 200 full entities cost?);
  - let the SDK surface a 429 as a typed error (`RateLimitedError { retryAfter, code }`) instead of letting viem sleep for 48 minutes, or cap the delay;
  - give a way to see the remaining anonymous budget on success: today `ratelimit` on a successful query shows only the per-minute counter, and the `Arkiv-Quota-Used-Percent` header the CORS config exposes is absent for anonymous calls;
  - consider charging less for point reads by key, which is what `getEntity()` does.

## F10. `EntityMutationError` has no machine-readable reason

- **Surface:** `EntityMutationError` from every write; Docs › TypeScript SDK › Mutating data › "Handle write errors".
- **Expected:** the docs say "Its message names the reason, and `txHash` is set when the transaction reached the chain", and list the reasons by typed name (`NotOwner`, `EntityNotFound`, `ReadOnlyEntity`, `ExpiryNotExtended`…). We expected to branch on `error.reason`.
- **Actual:** the messages are good: readable prose with the key, the owner and the numbers (W5, W7, W8). But the error has only `message`, `cause`, `txHash` and `name`; no `reason`. The decoded name (`NotOwner`) exists only two levels down, at `error.cause.cause.data.abiItem.name`, behind viem's `ContractFunctionExecutionError` and `ContractFunctionRevertedError`. Code that must act on the reason has to walk `cause` or match prose such as "would shorten its life". The `txHash` statement is accurate: in W5–W8 and W12 it is `null`, the nonce did not move and no GLM was spent (the write was rejected before it was sent).
- **Steps:** `scripts/probe-write.ts`, probes W5, W7, W8a, W8b and W12 print `ownProps`, `reasonOnError` and `revertNameInCauseChain`.
- **Impact on Tacho:** small. The CLI prints the message as it is. A production agent that decides "retry or give up" by reason would match strings.
- **Fix:** expose `error.reason = { name, args }` on `EntityMutationError`, taken from the decoded revert.

---

## Tested paths that worked as documented

- **T1. Page size limit.** `limit(500)` fails in the SDK before sending, with a clear message ("limit 500 exceeds the node maximum of 200. Page through the results with the cursor instead."). The raw RPC returns `-32602` with the same text. Matches the docs. (P4)
- **T2. `atBlock` history.** Reads at head − 43 200 (one day) and head − 302 400 (seven days) succeed in ~150 ms. The docs say the node keeps "a limited history"; on Tiramisu we did not reach the limit within the chain's lifetime: a block near genesis answers with an empty result, not an error. Tacho's counterparty check relies on `atBlock` to ask "was the mandate alive when this record landed?" (P6)
- **T3. `$creator` filters.** `createdBy()` matches regardless of address case. `not(eq("$creator", addr(x)))` works and renders as `NOT $creator = addr(…)`. `eq("$key", key(k))` with `atBlock` returns a single entity as of that block. (`test/queries.test.ts` checks that our query strings match the SDK builder's `toString()` byte for byte.)
- **T4. Plain GLM transfers work** (W1). A transfer between two wallets costs 21 000 gas, 0.000021 GLM. One faucet claim can therefore fund every role, which settled the open question in our plan: we asked for GLM once and shared it with `fund`.
- **T5. `expiresAt` and visibility** (W2, W3). `createEntity` returns an `expiresAt` equal to the stored expiry (difference 0 blocks), and the entity is visible to `arkiv_query` 95–123 ms after the call returns. A create costs about 90 000 gas, 0.00009 GLM at 1 gwei.
- **T6. Create and hand over in one batch** (W4, W12). `executeBatch({ creates, ownershipChanges })` with a salt from `predictEntityKeys` mints exactly the predicted key, and the entity is owned by `0x…dEaD` from its first block while `$creator` stays the agent; `creationFlags` reads back as raw 3 (`readonly` + `permissionlessExtension`). The batch costs 110 432 gas, 0.00011 GLM. The zero address is refused ("cannot be transferred to the zero address", `TransferToZeroAddress` in the docs); any other address, including `0x…dEaD`, is accepted. This is what makes "nobody can delete it" a property of the chain and not a promise.
- **T7. The ownership and lifetime rules hold, and the errors are readable** (W5–W8). The creator cannot delete the sealed entity (the message names the owner); a shorter extension is rejected ("would shorten its life"); a non-owner cannot extend without `permissionlessExtension`; a `readonly` entity rejects `patchEntity` and the message says what it still allows ("Its expiry can still be extended, and it can be transferred or deleted"), matching the docs. A permissionless extension by a stranger costs 25 210 gas. Rejected writes cost nothing: they are stopped before sending (`txHash` null, nonce and balance unchanged), see F10.
- **T8. WebSocket events** (W9). With a `webSocket()` transport and no `fromBlock`, `EntityDeleted` arrived 1.6 s after the delete was sent (1.6–3.1 s over five runs). `deleteEntity` costs 24 510 gas.
- **T9. Odd-second lifetimes** (W10). `ExpirationTime.fromSeconds(901)` throws before anything is sent: "a lifetime must be a multiple of the 2s block time … Try 900 or 902, or ExpirationTime.fromBlocks(n)". The message tells you the fix.
