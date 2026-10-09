# Tacho data contract — `tacho/v1`

This is the contract another team needs to **write** compatible records from any agent framework, or to **read and audit** them without asking us. Source of truth in code: [`src/core/constants.ts`](../src/core/constants.ts), [`src/core/entities.ts`](../src/core/entities.ts), [`src/core/queries.ts`](../src/core/queries.ts).

- **Network:** Tiramisu testnet, chain ID `7738577`. RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`.
- **SDK:** `@arkiv-network/sdk` 0.8.1.
- **Namespace:** every entity carries `project = str('tacho/v1')`. The namespace is public on purpose: anyone can write into it. **Trust never comes from an attribute. It comes from `$creator`.**

## Roles and wallets

| Role | Writes | Trusted because |
|---|---|---|
| Principal (the business that delegates) | `mandate` | `$creator` of the mandate |
| Agent (the AI that acts) | `record` | `$creator` of the record equals the mandate's `agent` attribute |
| Counterparty (who gets paid) | `ack` | `$creator` of the ack is the counterparty the verifier expects |
| Seal address `0x000000000000000000000000000000000000dEaD` | nothing | Owner of every record and ack. Nobody holds its key, so nobody can delete them |

Demo wallets on Tiramisu: [README › On-chain evidence](../README.md#on-chain-evidence).

## Entity types

### `mandate` — the authority a principal grants one agent

| | |
|---|---|
| Written by | principal (`$creator`) |
| Attributes (indexed) | `project` str = `tacho/v1` · `type` str = `mandate` · `agent` addr · `issued_ms` u64 (Unix ms) |
| Payload | `application/json`, public policy (below). Public on purpose: a counterparty must check an action against it without asking anyone |
| Expiration | **the lease**, `policy.leaseSeconds` (demo: 900 s = 450 blocks). The principal's heartbeat moves it with `extendEntity(fromSeconds(lease))`. No heartbeat, no authority |
| Flags | `readonly: true` — limits cannot change under the agent; to change them, revoke and reissue. `permissionlessExtension: false` — only the principal can keep it alive |
| Ownership | stays with the principal; revocation = `deleteEntity` |

Policy payload (`v: 1`). Amounts are integers in minor units, written as decimal strings:

```json
{
  "v": 1,
  "purpose": "Fleet card for the dispatcher agent of a 12-truck haulier (synthetic demo): fuel and road tolls only.",
  "currency": "RUB",
  "decimals": 2,
  "perActionCap": "1500000",
  "perDayCap": "4000000",
  "kinds": ["fuel", "toll"],
  "dayOffsetMinutes": 180,
  "leaseSeconds": 900,
  "retentionDays": 45
}
```

Optional `counterparties`: an allowlist of wallets. Validation: `parsePolicy()` in [`policy.ts`](../src/core/policy.ts). A payload that fails validation is ignored, never trusted.

### `record` — one attempted action, allowed or refused

| | |
|---|---|
| Written by | agent (`$creator`) |
| Attributes (indexed) | `project` str · `type` str = `record` · `mandate` key · `kind` str · `amount` u64 (minor units) · `verdict` str (`allowed` \| `refused`) · `reason` str · `ts_ms` u64 (Unix ms) |
| Payload | `application/json` envelope `{ "v": 1, "alg": "A256GCM", "iv": "<base64url>", "ct": "<base64url>" }`: the action details (vehicle, station, litres, the agent's rationale) encrypted with AES-256-GCM. The AAD is `tacho/v1|record|<mandate>|<kind>|<amount>|<verdict>|<reason>|<ts_ms>`, so the details cannot be presented as belonging to another record |
| Expiration | `policy.retentionDays` (demo: 45 days = 1 944 000 blocks): the dispute window, chosen by the principal |
| Flags | `readonly: true` · `permissionlessExtension: true` — any party to a dispute can keep the evidence alive |
| Ownership | **handed to the seal address in the same atomic batch that creates it** (`predictEntityKeys` → `executeBatch({ creates: [record with salt], ownershipChanges: [{ entityKey: predicted, newOwner: SEAL }] })`). The agent's operator holds the agent's key; if the agent owned its records, the operator could delete them after an incident |

`reason` values: `ok`, `no_live_mandate`, `wrong_agent`, `kind_not_allowed`, `counterparty_not_allowed`, `over_action_cap`, `over_day_cap`, `invalid_amount`.

Why each attribute is an attribute (not payload): `mandate` joins records to their authority; `verdict` and `kind` filter; `amount` and `ts_ms` are **u64 so ranges work** (daily cap, large actions); `reason` lets a public auditor see why something was refused without the data key. Everything else is ciphertext.

### `ack` — a counterparty honoured a record

| | |
|---|---|
| Written by | counterparty (`$creator`) |
| Attributes (indexed) | `project` str · `type` str = `ack` · `record` key · `mandate` key · `amount` u64 · `ts_ms` u64 |
| Payload | `application/json` `{ "v": 1 }` |
| Expiration | same retention as the mandate's records |
| Flags / ownership | `readonly`, `permissionlessExtension`, sealed in the same batch, like records |

An ack is written only after every verification check passes. A second ack for the same record is refused, which stops the same record from being spent twice.

## Lifetimes at a glance

| Entity | Lifetime | Who can extend | Product meaning |
|---|---|---|---|
| mandate | 15 min lease | principal only | The agent may act only while a human keeps renewing |
| record | 45 days | anyone | Evidence for the dispute window; a party in a dispute keeps it alive |
| ack | 45 days | anyone | The counterparty's side of the evidence |

## Queries the app runs

All are built in [`src/core/queries.ts`](../src/core/queries.ts). The strings below are exactly what the node receives. `$creator = addr(…)` is what `.createdBy(…)` adds. `A` is the agent, `P` the principal, `M` a mandate key, `R` a record key.

| # | Question | Query | Where |
|---|---|---|---|
| Q1 | Which live mandates name this agent? | `project = str('tacho/v1') AND type = str('mandate') AND agent = addr(A)` | Inspector › Authority |
| Q2 | Which agents does this principal authorise? | `project = str('tacho/v1') AND type = str('mandate') AND $creator = addr(P)` | Principal console |
| Q3 | Everything the agent attempted (trusted) | `project = str('tacho/v1') AND type = str('record') AND $creator = addr(A)` | Inspector › Records; CLI `inspect` |
| Q4 | Records claiming M but **not** written by its agent (forgeries) | `project = str('tacho/v1') AND type = str('record') AND mandate = key(M) AND NOT $creator = addr(A)` | Inspector › Forged records |
| Q5 | Spent today under M (the daily cap) | `project = str('tacho/v1') AND type = str('record') AND mandate = key(M) AND verdict = str('allowed') AND ts_ms >= u64(dayStart) [AND ts_ms <= u64(t)] AND $creator = addr(A)` | Agent before every decision; counterparty with `atBlock` |
| Q6 | Was M alive when R landed? | `$key = key(M)` with `atBlock = R.$createdAt` | Counterparty check |
| Q7 | Has R been honoured already? | `project = str('tacho/v1') AND type = str('ack') AND record = key(R) [AND $creator = addr(C)]` | Counterparty check |
| Q8 | Refusals | `… type = str('record') AND verdict = str('refused') AND $creator = addr(A)` | CLI, schema example |
| Q9 | Large actions | `… type = str('record') AND amount >= u64(X) AND $creator = addr(A)` | CLI, schema example |
| Q10 | Evidence about to expire | `… type = str('record') AND $expiresAt < u64(head + N) AND $creator = addr(A)` | Candidates for a permissionless extension |
| Q11 | Every record in the namespace, from anyone | `project = str('tacho/v1') AND type = str('record')` | Home › Live feed, labelled genuine or forged by `$creator` |
| Q12 | Which records under M have been honoured, and by whom | `project = str('tacho/v1') AND type = str('ack') AND mandate = key(M)` | Inspector › Records ("honoured by" shows each ack's `$creator`) |
| Q13 | Which of the agent's records are sealed (`.ownedBy(seal)`) | `project = str('tacho/v1') AND type = str('record') AND $owner = addr(0x…dEaD) AND $creator = addr(A)` | Inspector › Records ("all sealed" badge) |
| Q14 | Which of the agent's records could still be deleted (should be none) | `project = str('tacho/v1') AND type = str('record') AND NOT $owner = addr(0x…dEaD) AND $creator = addr(A)` | Inspector › red "Unsealed records" panel |

Pagination: the inspector and CLI walk pages with the SDK cursor (`hasNextPage()`/`next()`, 200 per page). Every page of a walk reads the same block. Results come newest first; nothing in Tacho depends on any other order.

### Reproduce any query without our code

```bash
curl -s https://rpc.tiramisu.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["project = str('\''tacho/v1'\'') AND type = str('\''record'\'') AND $creator = addr(0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f)",{"select":{"key":true,"owner":true,"creator":true,"createdAt":true,"expiresAt":true,"attributes":true},"limit":"0x32"}]}'
```

Every panel of the inspector has a `</> query` button that prints its query and a curl like this one.

## Writes the app makes

| Operation | SDK call | Signed by |
|---|---|---|
| Issue a mandate | `createEntity(mandateCreate(...))` | principal |
| Heartbeat | `extendEntity({ entityKey: M, expires: fromSeconds(lease) })` | principal |
| Revoke | `deleteEntity({ entityKey: M })` | principal |
| Record an attempt | `predictEntityKeys({ owner: A, count: 1 })` → `executeBatch({ creates: [record + salt], ownershipChanges: [→ seal] })` | agent |
| Acknowledge | same pattern with an `ack` | counterparty |
| Keep evidence alive | `extendEntity({ entityKey: R, expires: fromDays(60) })` | anyone (permissionless) |

Events: the agent and the inspector use `watchEntityEvents` over a **WebSocket** transport with no `fromBlock`. `EntityDeleted` on M halts the agent; `ExpiryExtended` on M is a heartbeat; `EntityCreated` by A refreshes the inspector.

## What deliberately stays off Arkiv

- Private keys and the AES data key. The key travels in the URL fragment (`#/agent/…?k=…`), which browsers never send to a server.
- Plaintext action details and any personal data. All demo data is synthetic: vehicle IDs like `TRK-07`, stations like "Fuel station 12 (synthetic)".
- The payment itself (card, USDC, invoice). Arkiv holds the authority and the evidence, not the money.
- The agent's full LLM transcript. Only a one-line rationale goes into the encrypted payload.
