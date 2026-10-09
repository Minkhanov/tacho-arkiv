import { ExpirationTime, jsonToPayload, type CreateEntityParameters, type ExecuteBatchParameters } from "@arkiv-network/sdk"
import { addr, key, str, u64 } from "@arkiv-network/sdk/attr"
import { CONTENT_TYPE, PROJECT, REASON, SEAL_ADDRESS, TYPE, VERDICT, type Reason, type Verdict } from "./constants.ts"
import { isSealedEnvelope, seal, type SealedEnvelope } from "./crypto.ts"
import { parsePolicy, policyToJson, type Address, type Policy } from "./policy.ts"

export type Hex = `0x${string}`

/** The subset of an Arkiv entity this library reads. Matches the SDK's Entity and FullEntity. */
export interface EntityLike {
  key?: Hex | undefined
  owner?: Hex | undefined
  creator?: Hex | undefined
  createdAt?: bigint | undefined
  expiresAt?: bigint | undefined
  creationFlags?: { readonly: boolean; permissionlessExtension: boolean } | undefined
  attributes?: Record<string, { type: string; value: unknown }> | undefined
  payload?: Uint8Array | undefined
}

/** Every field a Tacho screen needs, in one selection. */
export const FULL_SELECTION = {
  key: true,
  owner: true,
  creator: true,
  createdAt: true,
  expiresAt: true,
  creationFlags: true,
  payload: true,
  attributes: true,
} as const

export class SchemaError extends Error {
  override name = "SchemaError"
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/**
 * A mandate: the authority a principal grants one agent wallet.
 * - `readonly`: the limits cannot change under the agent's feet; to change them, revoke and reissue.
 * - lifetime = the lease. Only the principal (the owner) can extend it, which is the heartbeat.
 */
export function mandateCreate(args: { agent: Address; policy: Policy; issuedMs: number }): CreateEntityParameters {
  return {
    payload: jsonToPayload(policyToJson(args.policy)),
    contentType: CONTENT_TYPE.policy,
    attributes: {
      project: str(PROJECT),
      type: str(TYPE.mandate),
      agent: addr(args.agent),
      issued_ms: u64(BigInt(args.issuedMs)),
    },
    expires: ExpirationTime.fromSeconds(args.policy.leaseSeconds),
    flags: { readonly: true, permissionlessExtension: false },
  }
}

/** The heartbeat: move the mandate's expiry to now + lease. */
export function heartbeat(mandateKey: Hex, leaseSeconds: number) {
  return { entityKey: mandateKey, expires: ExpirationTime.fromSeconds(leaseSeconds) }
}

export interface RecordFields {
  mandate: Hex
  kind: string
  amount: bigint
  verdict: Verdict
  reason: Reason
  tsMs: number
}

/** Additional authenticated data that binds encrypted details to a record's public attributes. */
export function recordAad(f: RecordFields): string {
  return [PROJECT, TYPE.record, f.mandate.toLowerCase(), f.kind, f.amount.toString(), f.verdict, f.reason, String(f.tsMs)].join("|")
}

function recordAttributes(f: RecordFields) {
  return {
    project: str(PROJECT),
    type: str(TYPE.record),
    mandate: key(f.mandate),
    kind: str(f.kind),
    amount: u64(f.amount),
    verdict: str(f.verdict),
    reason: str(f.reason),
    ts_ms: u64(BigInt(f.tsMs)),
  }
}

/**
 * One atomic batch that creates a record and hands it to the seal address. Both apply or
 * neither does, so there is no block in which the agent's operator owns the record and could
 * delete it. The record's key must be predicted (with its salt) so the ownership change can
 * name it inside the same transaction.
 */
export async function recordBatch(args: {
  fields: RecordFields
  details: Record<string, unknown>
  dataKey: string
  retentionDays: number
  predicted: { key: Hex; salt: bigint }
}): Promise<ExecuteBatchParameters> {
  const envelope = await seal(args.details, args.dataKey, recordAad(args.fields))
  return {
    creates: [
      {
        payload: jsonToPayload(envelope),
        contentType: CONTENT_TYPE.sealed,
        attributes: recordAttributes(args.fields),
        expires: ExpirationTime.fromDays(args.retentionDays),
        flags: { readonly: true, permissionlessExtension: true },
        salt: args.predicted.salt,
      },
    ],
    ownershipChanges: [{ entityKey: args.predicted.key, newOwner: SEAL_ADDRESS }],
  }
}

export interface AckFields {
  record: Hex
  mandate: Hex
  amount: bigint
  tsMs: number
}

/** A counterparty's acknowledgement that it honoured a record. Sealed the same way as records. */
export function ackBatch(args: { fields: AckFields; retentionDays: number; predicted: { key: Hex; salt: bigint } }): ExecuteBatchParameters {
  const f = args.fields
  return {
    creates: [
      {
        payload: jsonToPayload({ v: 1 }),
        contentType: CONTENT_TYPE.policy,
        attributes: {
          project: str(PROJECT),
          type: str(TYPE.ack),
          record: key(f.record),
          mandate: key(f.mandate),
          amount: u64(f.amount),
          ts_ms: u64(BigInt(f.tsMs)),
        },
        expires: ExpirationTime.fromDays(args.retentionDays),
        flags: { readonly: true, permissionlessExtension: true },
        salt: args.predicted.salt,
      },
    ],
    ownershipChanges: [{ entityKey: args.predicted.key, newOwner: SEAL_ADDRESS }],
  }
}

// ---------------------------------------------------------------------------------------------
// Reading. Anyone can write an entity with project = tacho/v1, so parsers check shape only;
// authorship is checked against `$creator` by the caller (see verify.ts).
// ---------------------------------------------------------------------------------------------

function attr<T>(e: EntityLike, name: string, type: string): T {
  const a = e.attributes?.[name]
  if (!a || a.type !== type) throw new SchemaError(`attribute ${name} must be ${type}`)
  return a.value as T
}

function base(e: EntityLike, expected: string) {
  if (!e.key || !e.creator || !e.owner || e.createdAt === undefined || e.expiresAt === undefined) {
    throw new SchemaError("entity is missing system fields; select key, owner, creator, createdAt and expiresAt")
  }
  if (attr<string>(e, "project", "str") !== PROJECT) throw new SchemaError("not a tacho/v1 entity")
  if (attr<string>(e, "type", "str") !== expected) throw new SchemaError(`not a ${expected}`)
  return {
    key: e.key,
    creator: e.creator as Address,
    owner: e.owner as Address,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    readonly: e.creationFlags?.readonly ?? false,
    permissionlessExtension: e.creationFlags?.permissionlessExtension ?? false,
  }
}

function payloadJson(e: EntityLike): unknown {
  if (!e.payload) throw new SchemaError("payload not selected")
  try {
    return JSON.parse(new TextDecoder().decode(e.payload))
  } catch {
    throw new SchemaError("payload is not JSON")
  }
}

const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

export interface Mandate {
  key: Hex
  /** `$creator`: the principal who granted the authority. Immutable. */
  principal: Address
  owner: Address
  agent: Address
  issuedMs: number
  policy: Policy
  createdAt: bigint
  expiresAt: bigint
  readonly: boolean
}

export function parseMandate(e: EntityLike): Mandate {
  const b = base(e, TYPE.mandate)
  return {
    key: b.key,
    principal: b.creator,
    owner: b.owner,
    agent: attr<Address>(e, "agent", "addr"),
    issuedMs: Number(attr<bigint>(e, "issued_ms", "u64")),
    policy: parsePolicy(payloadJson(e)),
    createdAt: b.createdAt,
    expiresAt: b.expiresAt,
    readonly: b.readonly,
  }
}

export interface TachoRecord extends RecordFields {
  key: Hex
  /** `$creator`: the wallet that wrote the record. Only the mandate's agent counts. */
  writer: Address
  owner: Address
  createdAt: bigint
  expiresAt: bigint
  readonly: boolean
  permissionlessExtension: boolean
  /** Owner is the seal address: nobody can delete the record. */
  sealed: boolean
  envelope?: SealedEnvelope
}

export function parseRecord(e: EntityLike): TachoRecord {
  const b = base(e, TYPE.record)
  const verdict = attr<string>(e, "verdict", "str")
  if (verdict !== VERDICT.allowed && verdict !== VERDICT.refused) throw new SchemaError("unknown verdict")
  const reason = attr<string>(e, "reason", "str")
  if (!(Object.values(REASON) as string[]).includes(reason)) throw new SchemaError("unknown reason")
  const rec: TachoRecord = {
    key: b.key,
    writer: b.creator,
    owner: b.owner,
    createdAt: b.createdAt,
    expiresAt: b.expiresAt,
    readonly: b.readonly,
    permissionlessExtension: b.permissionlessExtension,
    sealed: sameAddr(b.owner, SEAL_ADDRESS),
    mandate: attr<Hex>(e, "mandate", "key"),
    kind: attr<string>(e, "kind", "str"),
    amount: attr<bigint>(e, "amount", "u64"),
    verdict: verdict as Verdict,
    reason: reason as Reason,
    tsMs: Number(attr<bigint>(e, "ts_ms", "u64")),
  }
  if (e.payload) {
    try {
      const env = payloadJson(e)
      if (isSealedEnvelope(env)) rec.envelope = env
    } catch {
      /* a record with an unreadable payload is still a record; details just cannot be shown */
    }
  }
  return rec
}

export interface Ack extends AckFields {
  key: Hex
  /** `$creator`: the counterparty. */
  writer: Address
  owner: Address
  createdAt: bigint
  expiresAt: bigint
  sealed: boolean
}

export function parseAck(e: EntityLike): Ack {
  const b = base(e, TYPE.ack)
  return {
    key: b.key,
    writer: b.creator,
    owner: b.owner,
    createdAt: b.createdAt,
    expiresAt: b.expiresAt,
    sealed: sameAddr(b.owner, SEAL_ADDRESS),
    record: attr<Hex>(e, "record", "key"),
    mandate: attr<Hex>(e, "mandate", "key"),
    amount: attr<bigint>(e, "amount", "u64"),
    tsMs: Number(attr<bigint>(e, "ts_ms", "u64")),
  }
}

export { sameAddr }
