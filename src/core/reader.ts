import { NoEntityFoundError, type PublicArkivClient } from "@arkiv-network/sdk"
import { FULL_SELECTION, type EntityLike, type Hex } from "./entities.ts"
import { byKey, type QuerySpec } from "./queries.ts"

/**
 * Everything Tacho reads from Arkiv, behind one small interface. The browser, the CLI and the
 * counterparty all use the Arkiv implementation below; the tests use an in-memory one.
 */
export interface TachoReader {
  /** Current head block. */
  head(): Promise<bigint>
  /** A live entity, or null if it never existed, expired or was deleted. */
  getEntity(key: Hex): Promise<EntityLike | null>
  /** The entity as it was at `block`, or null if it was not alive then. */
  getEntityAt(key: Hex, block: bigint): Promise<EntityLike | null>
  /** Run a query and walk its pages until `max` entities (default 1 000). Newest first. */
  find(spec: QuerySpec, opts?: { atBlock?: bigint; max?: number }): Promise<EntityLike[]>
  /** One page, for cursor-driven UIs. */
  page(spec: QuerySpec, opts: { limit: number; cursor?: string }): Promise<{ entities: EntityLike[]; cursor?: string; blockNumber: bigint }>
  /** Unix time of a block in milliseconds. */
  blockTimeMs(block: bigint): Promise<number>
}

export function arkivReader(client: PublicArkivClient): TachoReader {
  const builder = (spec: QuerySpec) => {
    let b = client.select(FULL_SELECTION).where(spec.where)
    if (spec.ownedBy) b = b.ownedBy(spec.ownedBy)
    if (spec.createdBy) b = b.createdBy(spec.createdBy)
    return b
  }
  const blockTimes = new Map<bigint, number>()
  return {
    head: () => client.getBlockNumber(),
    async getEntity(key) {
      try {
        return (await client.getEntity(key)) as EntityLike
      } catch (err) {
        if (err instanceof NoEntityFoundError) return null
        throw err
      }
    },
    async getEntityAt(key, block) {
      const page = await builder(byKey(key)).atBlock(block).limit(1).fetch()
      return (page.entities[0] as EntityLike | undefined) ?? null
    },
    async find(spec, opts = {}) {
      const max = opts.max ?? 1_000
      let b = builder(spec).limit(Math.min(200, max))
      if (opts.atBlock !== undefined) b = b.atBlock(opts.atBlock)
      let page = await b.fetch()
      const out: EntityLike[] = [...(page.entities as readonly EntityLike[])]
      while (out.length < max && page.hasNextPage()) {
        page = await page.next()
        out.push(...(page.entities as readonly EntityLike[]))
      }
      return out.slice(0, max)
    },
    async page(spec, opts) {
      let b = builder(spec).limit(opts.limit)
      if (opts.cursor) b = b.cursor(opts.cursor)
      const page = await b.fetch()
      const res: { entities: EntityLike[]; cursor?: string; blockNumber: bigint } = {
        entities: [...(page.entities as readonly EntityLike[])],
        blockNumber: page.blockNumber,
      }
      if (page.cursor) res.cursor = page.cursor
      return res
    },
    async blockTimeMs(block) {
      const cached = blockTimes.get(block)
      if (cached !== undefined) return cached
      const b = await client.getBlock({ blockNumber: block })
      const ms = Number(b.timestamp) * 1000
      blockTimes.set(block, ms)
      return ms
    },
  }
}
