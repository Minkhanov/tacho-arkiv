import { createPublicClient, createWalletClient, type EntityEvent } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, webSocket } from "viem"
import { nonceManager, privateKeyToAccount } from "viem/accounts"
import type { Hex } from "./entities.ts"

export interface RpcConfig {
  http?: string
  ws?: string
}

/** Read-only client over HTTP. Safe in the browser: no key. */
export function httpReader(rpc: RpcConfig = {}) {
  return createPublicClient({ chain: tiramisu, transport: http(rpc.http) })
}

/**
 * Read-only client over WebSocket, used for entity events. With a WebSocket transport and no
 * `fromBlock`, `watchEntityEvents` subscribes on the socket instead of polling over HTTP.
 */
export function wsReader(rpc: RpcConfig = {}) {
  return createPublicClient({ chain: tiramisu, transport: webSocket(rpc.ws) })
}

/** Wallet client from a private key (CLI only; never in the browser bundle). */
export function keyWallet(privateKey: Hex, rpc: RpcConfig = {}) {
  return createWalletClient({
    chain: tiramisu,
    transport: http(rpc.http),
    account: privateKeyToAccount(privateKey, { nonceManager }),
  })
}

export interface MandateWatchHandlers {
  onRevoked?: (e: EntityEvent) => void
  onRenewed?: (e: EntityEvent & { expiresAt?: bigint }) => void
  onError?: (err: Error) => void
}

/**
 * Follow one mandate over WebSocket. Revocation is an EntityDeleted event; a heartbeat is an
 * ExpiryExtended event. Lease expiry has no event, so callers also compare `expiresAt` with the head.
 */
export function watchMandate(client: ReturnType<typeof wsReader>, mandateKey: Hex, h: MandateWatchHandlers): () => void {
  const mine = (k: string) => k.toLowerCase() === mandateKey.toLowerCase()
  return client.watchEntityEvents({
    onEntityDeleted: (e) => {
      if (mine(e.entityKey)) h.onRevoked?.(e)
    },
    onExpiryExtended: (e) => {
      if (mine(e.entityKey)) h.onRenewed?.(e)
    },
    onError: (err) => h.onError?.(err),
  })
}
