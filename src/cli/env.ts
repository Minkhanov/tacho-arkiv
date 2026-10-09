import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { httpReader, keyWallet, wsReader, type RpcConfig } from "../core/clients.ts"
import type { Hex } from "../core/entities.ts"
import type { Address } from "../core/policy.ts"
import { arkivReader } from "../core/reader.ts"
import { arkivWriter, type TachoWriter } from "../core/writer.ts"

export const ROLES = ["principal", "agent", "counterparty", "forger"] as const
export type Role = (typeof ROLES)[number]

export function rpc(): RpcConfig {
  const cfg: RpcConfig = {}
  if (process.env.TACHO_RPC_HTTP) cfg.http = process.env.TACHO_RPC_HTTP
  if (process.env.TACHO_RPC_WS) cfg.ws = process.env.TACHO_RPC_WS
  return cfg
}

function keyOf(role: Role): Hex {
  const name = `TACHO_${role.toUpperCase()}_KEY`
  const k = process.env[name]
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is missing or malformed in .env (see .env.example)`)
  return k as Hex
}

export function addressOf(role: Role): Address {
  return privateKeyToAccount(keyOf(role)).address as Address
}

export function dataKey(): string {
  const k = process.env.TACHO_DATA_KEY
  if (!k || !/^[A-Za-z0-9_-]{43}$/.test(k)) throw new Error("TACHO_DATA_KEY is missing or malformed in .env (32 bytes, base64url)")
  return k
}

let _public: ReturnType<typeof httpReader> | undefined
export function publicClient() {
  return (_public ??= httpReader(rpc()))
}

export function reader() {
  return arkivReader(publicClient())
}

export function walletOf(role: Role) {
  return keyWallet(keyOf(role), rpc())
}

export function writerOf(role: Role): TachoWriter {
  return arkivWriter(walletOf(role), publicClient())
}

export function socket() {
  return wsReader(rpc())
}

// ---------------------------------------------------------------------------------------------
// Public demo state: entity keys and transaction hashes only, never secrets. Committed as evidence.
// ---------------------------------------------------------------------------------------------

export interface DemoState {
  network: "tiramisu"
  wallets: Record<Role, Address>
  mandate?: { key: Hex; txHash: Hex; principal: Address; agent: Address; issuedAt: string }
  events: Array<{ at: string; role: Role; action: string; entityKey?: Hex; txHash?: Hex; block?: string; note?: string }>
}

export const STATE_FILE = resolve(process.cwd(), "demo/state.json")

let _state: DemoState | undefined
/** One shared state object per process, so commands that call each other never overwrite each other's events. */
export function loadState(): DemoState {
  if (_state) return _state
  _state = existsSync(STATE_FILE)
    ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as DemoState)
    : { network: "tiramisu", wallets: Object.fromEntries(ROLES.map((r) => [r, addressOf(r)])) as Record<Role, Address>, events: [] }
  return _state
}

export function saveState(s: DemoState) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n")
}

export function logEvent(s: DemoState, e: Omit<DemoState["events"][number], "at">) {
  s.events.push({ at: new Date().toISOString(), ...e })
  saveState(s)
}
