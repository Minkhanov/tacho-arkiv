import { createPublicClient, createWalletClient, type EntityEvent } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { custom, webSocket, type EIP1193Provider } from "viem"
import { rpcHttp, TIRAMISU_CHAIN } from "../../src/core/clients.ts"
import { TIRAMISU } from "../../src/core/constants.ts"
import { arkivReader } from "../../src/core/reader.ts"
import { arkivWriter } from "../../src/core/writer.ts"
import type { Address } from "../../src/core/policy.ts"

/** Public demo wallets (addresses only). The keys live in the CLI's .env, never here. */
export const DEMO = {
  principal: "0x4B25c7E2e178D275Ff3285f2832Bb29D13Bd0591",
  agent: "0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f",
  counterparty: "0x00cb37E03ec19cf0539cb50478B3CFf4e386ED59",
  forger: "0x9288957a5294c7210796aBb6F8384a09Be35622E",
} as const satisfies Record<string, Address>

/**
 * The public RPC gives each anonymous IP a small query budget (HTTP 429, ANON_COST_LIMITED). A visitor who runs
 * into it can open the same link with their own free key from hub.arkiv.network/api-keys: `...?apikey=<key>`.
 * The key stays in the URL fragment, which the browser never sends to a server. Only the official RPC host is
 * ever used, so a crafted link cannot point the inspector at a server that invents records.
 */
function rpcWithKey(base: string): string {
  const fromLink = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("apikey")
  // Optional, for a deployed build only: a Hub key locked to the site's origin (see README › Rate limits of the public RPC).
  const fromBuild = import.meta.env.VITE_ARKIV_KEY as string | undefined
  const key = fromLink || fromBuild
  return key && /^[A-Za-z0-9_-]{8,128}$/.test(key) ? `${base}/${key}` : base
}
export const RPC_HTTP = rpcWithKey(TIRAMISU.http)
export const RPC_WS = rpcWithKey(TIRAMISU.ws)

/** Reads go straight from the browser to the public Tiramisu RPC. There is no Tacho backend. */
export const publicClient = createPublicClient({ chain: TIRAMISU_CHAIN, transport: rpcHttp(RPC_HTTP) })
export const reader = arkivReader(publicClient)

let socketClient: ReturnType<typeof makeSocket> | undefined
function makeSocket() {
  return createPublicClient({ chain: TIRAMISU_CHAIN, transport: webSocket(RPC_WS) })
}

/** One shared WebSocket subscription to entity events; the UI reacts without a refresh loop. */
const listeners = new Set<(e: EntityEvent) => void>()
let unwatch: (() => void) | undefined
export function onEntityEvent(fn: (e: EntityEvent) => void): () => void {
  listeners.add(fn)
  if (!unwatch) {
    socketClient ??= makeSocket()
    unwatch = socketClient.watchEntityEvents({
      onEvent: (e) => listeners.forEach((l) => l(e)),
      onError: (err) => console.warn("[tacho] entity event stream:", err.message),
    })
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && unwatch) {
      unwatch()
      unwatch = undefined
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Optional: a browser wallet for the principal console and permissionless extensions.
// ---------------------------------------------------------------------------------------------

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

export const TIRAMISU_PARAMS = {
  chainId: "0x" + tiramisu.id.toString(16),
  chainName: "Arkiv Tiramisu testnet",
  nativeCurrency: { name: "Golem", symbol: "GLM", decimals: 18 },
  rpcUrls: ["https://rpc.tiramisu.db-chain.testnet.arkiv.network"],
  blockExplorerUrls: ["https://tiramisu.explorer.arkiv.network"],
}

export async function connectWallet() {
  const eth = window.ethereum
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or any EIP-1193 wallet) to sign as a principal.")
  const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[]
  if (!account) throw new Error("The wallet returned no account")
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: TIRAMISU_PARAMS.chainId }] })
  } catch {
    await eth.request({ method: "wallet_addEthereumChain", params: [TIRAMISU_PARAMS] })
  }
  const wallet = createWalletClient({ chain: tiramisu, transport: custom(eth), account })
  return { account, writer: arkivWriter(wallet, publicClient) }
}
