/**
 * An in-memory Arkiv for unit tests. It models the rules Tacho depends on: one block per
 * transaction, entity expiry and history (for atBlock reads), owner-only writes, readonly and
 * permissionless-extension flags, atomic batches, predicted keys, and query evaluation over the
 * same expression trees the SDK sends to the node. It is not a full node; the integration test
 * runs the same flows against Tiramisu.
 */
import { createHash, randomBytes } from "node:crypto"
import { resolveExpiry, type CreateEntityParameters, type ExecuteBatchParameters } from "@arkiv-network/sdk"
import type { Expression } from "@arkiv-network/sdk/query"
import type { EntityLike, Hex } from "../src/core/entities.ts"
import type { Address } from "../src/core/policy.ts"
import type { QuerySpec } from "../src/core/queries.ts"
import type { TachoReader } from "../src/core/reader.ts"
import type { TachoWriter } from "../src/core/writer.ts"

type Value = { type: string; value: unknown }

interface Stored {
  key: Hex
  creator: Address
  createdAt: bigint
  /** [fromBlock, value] pairs, oldest first */
  owners: Array<[bigint, Address]>
  expiries: Array<[bigint, bigint]>
  deletedAt?: bigint
  flags: { readonly: boolean; permissionlessExtension: boolean }
  attributes: Record<string, Value>
  payload: Uint8Array
}

export class ChainError extends Error {
  override name = "EntityMutationError"
}

const lower = (a: string) => a.toLowerCase()
const at = <T>(hist: Array<[bigint, T]>, block: bigint): T => {
  let v = hist[0]![1]
  for (const [b, x] of hist) if (b <= block) v = x
  return v
}

export class FakeArkiv {
  block = 1_000n
  readonly genesisMs: number
  private entities = new Map<string, Stored>()
  private nonces = new Map<string, bigint>()
  /** Every transaction, for assertions. */
  readonly txs: Array<{ block: bigint; from: Address; kind: string }> = []

  constructor(genesisMs = Date.UTC(2026, 9, 9, 9, 0, 0)) {
    this.genesisMs = genesisMs
  }

  timeMs(block = this.block): number {
    return this.genesisMs + Number(block - 1_000n) * 2_000
  }

  /** Advance the chain without transactions (lets leases expire). */
  mine(blocks = 1n) {
    this.block += blocks
  }

  private alive(s: Stored, block: bigint): boolean {
    if (s.createdAt > block) return false
    if (s.deletedAt !== undefined && s.deletedAt <= block) return false
    return block < at(s.expiries, block)
  }

  private view(s: Stored, block: bigint): EntityLike & { key: Hex } {
    return {
      key: s.key,
      creator: s.creator,
      owner: at(s.owners, block),
      createdAt: s.createdAt,
      expiresAt: at(s.expiries, block),
      creationFlags: { ...s.flags },
      attributes: structuredClone(s.attributes),
      payload: s.payload,
    }
  }

  private sys(s: Stored, block: bigint, name: string): Value | undefined {
    switch (name) {
      case "$key":
        return { type: "key", value: s.key }
      case "$creator":
        return { type: "addr", value: s.creator }
      case "$owner":
        return { type: "addr", value: at(s.owners, block) }
      case "$expiresAt":
        return { type: "u64", value: at(s.expiries, block) }
      default:
        return s.attributes[name]
    }
  }

  private match(s: Stored, block: bigint, e: Expression): boolean {
    switch (e.kind) {
      case "and":
        return e.expressions.every((x) => this.match(s, block, x))
      case "or":
        return e.expressions.some((x) => this.match(s, block, x))
      case "not":
        return !this.match(s, block, e.expression)
      case "exists":
        return this.sys(s, block, e.name) !== undefined
      case "startsWith": {
        const a = this.sys(s, block, e.name)
        return a?.type === "str" && String(a.value).startsWith(String(e.value.value))
      }
      case "typeOf":
        return this.sys(s, block, e.name)?.type === e.tag
      case "comparison": {
        const a = this.sys(s, block, e.name)
        const v = e.value as Value
        if (!a || a.type !== v.type) return false
        const norm = (x: unknown) => (typeof x === "string" ? lower(x) : x)
        const l = norm(a.value) as bigint | number | string
        const r = norm(v.value) as bigint | number | string
        switch (e.operator) {
          case "=":
            return l === r
          case "!=":
            return l !== r
          case "<":
            return l < r
          case "<=":
            return l <= r
          case ">":
            return l > r
          case ">=":
            return l >= r
        }
      }
    }
    return false
  }

  private query(spec: QuerySpec, block: bigint): Array<EntityLike & { key: Hex }> {
    const out: Stored[] = []
    for (const s of this.entities.values()) {
      if (!this.alive(s, block)) continue
      if (spec.createdBy && lower(s.creator) !== lower(spec.createdBy)) continue
      if (spec.ownedBy && lower(at(s.owners, block)) !== lower(spec.ownedBy)) continue
      if (spec.where.every((w) => this.match(s, block, w))) out.push(s)
    }
    // newest first, like the node
    out.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1))
    return out.map((s) => this.view(s, block))
  }

  keyFor(owner: Address, nonce: bigint, salt: bigint): Hex {
    return ("0x" + createHash("sha256").update(`${lower(owner)}|${nonce}|${salt}`).digest("hex")) as Hex
  }

  // ----------------------------------------------------------------------------- reader
  reader(): TachoReader {
    return {
      head: async () => this.block,
      getEntity: async (key) => {
        const s = this.entities.get(lower(key))
        return s && this.alive(s, this.block) ? this.view(s, this.block) : null
      },
      getEntityAt: async (key, block) => {
        const s = this.entities.get(lower(key))
        return s && this.alive(s, block) ? this.view(s, block) : null
      },
      find: async (spec, opts = {}) => this.query(spec, opts.atBlock ?? this.block).slice(0, opts.max ?? 1_000),
      page: async (spec, opts) => {
        const all = this.query(spec, this.block)
        const start = opts.cursor ? Number(opts.cursor) : 0
        const entities = all.slice(start, start + opts.limit)
        const next = start + opts.limit
        return next < all.length ? { entities, cursor: String(next), blockNumber: this.block } : { entities, blockNumber: this.block }
      },
      blockTimeMs: async (block) => this.timeMs(block),
    }
  }

  // ----------------------------------------------------------------------------- writer
  writer(address: Address): TachoWriter {
    const tx = (kind: string) => {
      this.block += 1n
      this.txs.push({ block: this.block, from: address, kind })
      return ("0x" + randomBytes(32).toString("hex")) as Hex
    }
    return {
      address,
      predictKey: async () => {
        const salt = BigInt("0x" + randomBytes(16).toString("hex"))
        return { key: this.keyFor(address, this.nonces.get(lower(address)) ?? 0n, salt), salt }
      },
      createEntity: async (p) => {
        const txHash = tx("create")
        const s = this.applyCreate(address, p, this.block)
        return { entityKey: s.key, txHash, expiresAt: at(s.expiries, this.block) }
      },
      extendEntity: async ({ entityKey, expires }) => {
        const txHash = tx("extend")
        const expiresAt = this.applyExtend(address, entityKey, expires, this.block)
        return { txHash, expiresAt }
      },
      deleteEntity: async ({ entityKey }) => {
        const txHash = tx("delete")
        this.applyDelete(address, entityKey, this.block)
        return { txHash }
      },
      executeBatch: async (p: ExecuteBatchParameters) => {
        // Atomic: apply to a copy, commit only if every operation succeeds.
        const snapshot = new Map([...this.entities].map(([k, v]) => [k, structuredClone(v)]))
        const nonces = new Map(this.nonces)
        const block = this.block + 1n
        try {
          const created = (p.creates ?? []).map((c) => this.applyCreate(address, c, block).key)
          for (const pc of p.patches ?? []) throw new ChainError(`patches not modelled (${pc.entityKey})`)
          for (const d of p.deletes ?? []) this.applyDelete(address, d.entityKey, block)
          for (const x of p.extensions ?? []) this.applyExtend(address, x.entityKey, x.expires, block)
          for (const o of p.ownershipChanges ?? []) this.applyTransfer(address, o.entityKey, o.newOwner as Address, block)
          const txHash = tx("batch")
          return { txHash, createdEntities: created }
        } catch (err) {
          this.entities = snapshot
          this.nonces = nonces
          throw err
        }
      },
    }
  }

  private applyCreate(from: Address, p: CreateEntityParameters, block: bigint): Stored {
    const nonce = this.nonces.get(lower(from)) ?? 0n
    const salt = typeof p.salt === "bigint" ? p.salt : BigInt("0x" + randomBytes(16).toString("hex"))
    const key = this.keyFor(from, nonce, salt)
    this.nonces.set(lower(from), nonce + 1n)
    const target = resolveExpiry(p.expires, { currentBlock: block }).target
    if (target <= block) throw new ChainError("expiry must be after the inclusion block")
    const attributes: Record<string, Value> = {}
    for (const [name, v] of Object.entries(p.attributes ?? {})) attributes[name] = v as Value
    const s: Stored = {
      key,
      creator: from,
      createdAt: block,
      owners: [[block, from]],
      expiries: [[block, target]],
      flags: { readonly: !!p.flags?.readonly, permissionlessExtension: !!p.flags?.permissionlessExtension },
      attributes,
      payload: p.payload,
    }
    this.entities.set(lower(key), s)
    return s
  }

  private live(key: Hex, block: bigint): Stored {
    const s = this.entities.get(lower(key))
    if (!s || !this.alive(s, block)) throw new ChainError("EntityNotFound")
    return s
  }

  private applyExtend(from: Address, key: Hex, expires: CreateEntityParameters["expires"], block: bigint): bigint {
    const s = this.live(key, block)
    if (lower(at(s.owners, block)) !== lower(from) && !s.flags.permissionlessExtension) throw new ChainError("NotOwner")
    const target = resolveExpiry(expires, { currentBlock: block }).target
    const current = at(s.expiries, block)
    if (target < current) throw new ChainError("ExpiryNotExtended")
    if (target > current) s.expiries.push([block, target])
    return at(s.expiries, block)
  }

  private applyDelete(from: Address, key: Hex, block: bigint) {
    const s = this.live(key, block)
    if (lower(at(s.owners, block)) !== lower(from)) throw new ChainError("NotOwner")
    s.deletedAt = block
  }

  private applyTransfer(from: Address, key: Hex, to: Address, block: bigint) {
    const s = this.live(key, block)
    if (lower(at(s.owners, block)) !== lower(from)) throw new ChainError("NotOwner")
    s.owners.push([block, to])
  }
}

export const WALLETS = {
  principal: "0x4B25c7E2e178D275Ff3285f2832Bb29D13Bd0591",
  agent: "0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f",
  counterparty: "0x00cb37E03ec19cf0539cb50478B3CFf4e386ED59",
  forger: "0x9288957a5294c7210796aBb6F8384a09Be35622E",
} as const satisfies Record<string, Address>
