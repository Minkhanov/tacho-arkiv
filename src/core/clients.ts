import { createPublicClient, createWalletClient, type EntityEvent } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http, webSocket } from "viem"
import { nonceManager, privateKeyToAccount } from "viem/accounts"
import type { Hex } from "./entities.ts"

export interface RpcConfig {
  http?: string
  ws?: string
}

/**
 * The `tiramisu` chain object in SDK 0.8.1 has no `blockTime`, so viem assumes 12 s and polls for transaction
 * receipts every 4 s: a write takes ~4.8 s instead of ~3 s (friction.md F8). Tiramisu's block time is 2 s.
 */
export const TIRAMISU_CHAIN = { ...tiramisu, blockTime: 2000 } as typeof tiramisu

/** What this process has spent of the public RPC's query budget, from the `Arkiv-Cost` response header. */
export const meter = { units: 0, queries: 0 }

/** The public RPC refused a read because this IP's anonymous query budget is used up (HTTP 429, `ANON_COST_LIMITED`). */
export class RpcBudgetError extends Error {
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number, detail?: string) {
    const mins = Math.max(1, Math.ceil(retryAfterSeconds / 60))
    super(
      `The public Arkiv RPC has used up this IP's anonymous query budget (HTTP 429${detail ? `, ${detail}` : ""}). It resets in about ${mins} min. ` +
        `A free key from https://hub.arkiv.network/api-keys lifts the limit: put it in the RPC URL (.../<key>).`,
    )
    this.name = "RpcBudgetError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * viem sleeps for a 429's `Retry-After` before retrying. On the anonymous query budget that is ~48 minutes,
 * so an app looks frozen with no error (friction.md F9). Fail at once for long waits; leave short ones to viem.
 */
export function guardBudget(inner: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init)
    const cost = Number.parseInt(res.headers.get("arkiv-cost") ?? "", 10)
    if (cost > 0) {
      meter.units += cost
      meter.queries += 1
    }
    if (res.status === 429) {
      const wait = Number.parseInt(res.headers.get("retry-after") ?? "0", 10) || 0
      if (wait > 30) {
        let detail: string | undefined
        try {
          detail = ((await res.clone().json()) as { error?: string }).error
        } catch {
          // not JSON: keep the generic text
        }
        throw new RpcBudgetError(wait, detail)
      }
    }
    return res
  }
}

/** HTTP transport for every Tacho client: fails fast on an exhausted anonymous budget instead of hanging. */
export function rpcHttp(url?: string) {
  return http(url, { fetchFn: guardBudget(), retryCount: 2 })
}

/** Read-only client over HTTP. Safe in the browser: no key. */
export function httpReader(rpc: RpcConfig = {}) {
  return createPublicClient({ chain: TIRAMISU_CHAIN, transport: rpcHttp(rpc.http) })
}

/**
 * Read-only client over WebSocket, used for entity events. With a WebSocket transport and no
 * `fromBlock`, `watchEntityEvents` subscribes on the socket instead of polling over HTTP.
 */
export function wsReader(rpc: RpcConfig = {}) {
  return createPublicClient({ chain: TIRAMISU_CHAIN, transport: webSocket(rpc.ws) })
}

/** Wallet client from a private key (CLI only; never in the browser bundle). */
export function keyWallet(privateKey: Hex, rpc: RpcConfig = {}) {
  return createWalletClient({
    chain: TIRAMISU_CHAIN,
    transport: rpcHttp(rpc.http),
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
