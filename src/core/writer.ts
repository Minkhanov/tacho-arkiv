import type { CreateEntityParameters, ExecuteBatchParameters, PublicArkivClient, WalletArkivClient } from "@arkiv-network/sdk"
import type { Hex } from "./entities.ts"
import type { Address } from "./policy.ts"

/** Everything Tacho writes, behind one interface (Arkiv implementation below, in-memory one in tests). */
export interface TachoWriter {
  address: Address
  /** The key (and the salt that produces it) of this wallet's next create. */
  predictKey(): Promise<{ key: Hex; salt: bigint }>
  executeBatch(params: ExecuteBatchParameters): Promise<{ txHash: Hex; createdEntities: Hex[] }>
  createEntity(params: CreateEntityParameters): Promise<{ entityKey: Hex; txHash: Hex; expiresAt: bigint }>
  extendEntity(params: { entityKey: Hex; expires: CreateEntityParameters["expires"] }): Promise<{ txHash: Hex; expiresAt: bigint }>
  deleteEntity(params: { entityKey: Hex }): Promise<{ txHash: Hex }>
}

export function arkivWriter(wallet: WalletArkivClient, reader: PublicArkivClient): TachoWriter {
  const account = wallet.account
  if (!account) throw new Error("wallet client has no account")
  const address = account.address as Address
  return {
    address,
    async predictKey() {
      const [next] = await reader.predictEntityKeys({ owner: address, count: 1 })
      return { key: next.key, salt: next.salt }
    },
    async executeBatch(params) {
      const r = await wallet.executeBatch(params)
      return { txHash: r.txHash, createdEntities: r.createdEntities }
    },
    createEntity: (params) => wallet.createEntity(params),
    extendEntity: (params) => wallet.extendEntity(params),
    deleteEntity: (params) => wallet.deleteEntity(params),
  }
}
