import { createPublicClient, createWalletClient, type EntityEvent } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { custom, http, webSocket, type EIP1193Provider } from "viem"
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

/** Reads go straight from the browser to the public Tiramisu RPC. There is no Tacho backend. */
export const publicClient = createPublicClient({ chain: tiramisu, transport: http() })
export const reader = arkivReader(publicClient)

let socketClient: ReturnType<typeof makeSocket> | undefined
function makeSocket() {
  return createPublicClient({ chain: tiramisu, transport: webSocket() })
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
