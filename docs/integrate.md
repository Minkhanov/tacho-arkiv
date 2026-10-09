# Add a tachograph to your own agent

`tacho/v1` is a data contract, not a service. Any agent framework can write compatible records, and any merchant, auditor or insurer can verify them, without asking us. The full contract is in [`/arkiv/schema.md`](../arkiv/schema.md). This page shows the three integration points.

## 1. The principal grants a mandate

```ts
import { createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { addr, str, u64 } from "@arkiv-network/sdk/attr"

const policy = {
  v: 1, purpose: "Procurement agent: cloud credits only (synthetic)", currency: "USD", decimals: 2,
  perActionCap: "50000", perDayCap: "200000", kinds: ["cloud"], dayOffsetMinutes: 0,
  leaseSeconds: 900, retentionDays: 45,
}
const { entityKey: mandate } = await principalWallet.createEntity({
  payload: jsonToPayload(policy),
  contentType: "application/json",
  attributes: { project: str("tacho/v1"), type: str("mandate"), agent: addr(agentAddress), issued_ms: u64(BigInt(Date.now())) },
  expires: ExpirationTime.fromSeconds(policy.leaseSeconds),
  flags: { readonly: true, permissionlessExtension: false },
})
// Heartbeat while the human is around:
await principalWallet.extendEntity({ entityKey: mandate, expires: ExpirationTime.fromSeconds(policy.leaseSeconds) })
```

With this repository's library, the same thing is `issueMandate(writer, agentAddress, policy)` and `renewMandate(writer, mandate, lease)` ([`src/core/ops.ts`](../src/core/ops.ts)).

## 2. The agent records every attempt before it acts

Wrap the tool call that spends money. Decide from Arkiv, write the record whatever the verdict, and only then call the real tool, passing the record key to the counterparty.

```ts
import { attempt, arkivReader, arkivWriter } from "./src/core/index.ts"

const r = await attempt(
  { reader: arkivReader(publicClient), writer: arkivWriter(agentWallet, publicClient), mandateKey: mandate, principal: principalAddress, dataKey },
  { kind: "cloud", amount: 12_500n, tsMs: Date.now(), counterparty: vendorAddress, details: { sku: "gpu-hours", rationale: "nightly eval run" } },
)
if (r.decision.verdict === "allowed") await buyGpuHours({ tachoRecord: r.recordKey })
```

Without the library, the record is one `executeBatch`:

```ts
const [next] = await publicClient.predictEntityKeys({ owner: agentAddress, count: 1 })
await agentWallet.executeBatch({
  creates: [{
    payload: jsonToPayload(await seal(details, dataKey, aad)),   // AES-256-GCM, see src/core/crypto.ts
    contentType: "application/json",
    attributes: {
      project: str("tacho/v1"), type: str("record"), mandate: key(mandate), kind: str("cloud"),
      amount: u64(12_500n), verdict: str("allowed"), reason: str("ok"), ts_ms: u64(BigInt(Date.now())),
    },
    expires: ExpirationTime.fromDays(policy.retentionDays),
    flags: { readonly: true, permissionlessExtension: true },
    salt: next.salt,
  }],
  ownershipChanges: [{ entityKey: next.key, newOwner: "0x000000000000000000000000000000000000dEaD" }],
})
```

## 3. The counterparty verifies before it serves

```ts
import { verifyRecord, arkivReader } from "./src/core/index.ts"

const report = await verifyRecord(arkivReader(publicClient), recordKey, { expectedPrincipal: customerAddress, counterparty: myAddress })
if (!report.ok) throw new Error(report.checks.filter((c) => c.status === "fail").map((c) => c.detail).join("; "))
```

`verifyRecord` runs the checks in this order:

1. the record exists and is sealed;
2. the mandate was alive at the record's block (`atBlock`);
3. the mandate's `$creator` is the expected principal;
4. the record's `$creator` is the mandated agent;
5. the verdict is allowed, and the action is within the per-action rules;
6. the daily cap still holds, recomputed at that block;
7. the record's timestamp agrees with the block time;
8. nobody has acknowledged the record before.

In another language, the same checks are queries Q3–Q7 in the schema. Every one of them works over plain JSON-RPC (`arkiv_query`, `arkiv_getEntity`).
