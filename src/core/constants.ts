/**
 * The Tacho data contract, version 1. Everything another team needs to read or write
 * compatible entities lives here and in /arkiv/schema.md.
 */

/** Namespace attribute on every Tacho entity. Public on purpose: trust comes from `$creator`, never from this value. */
export const PROJECT = "tacho/v1" as const

/** Entity types (the `type` attribute). */
export const TYPE = {
  mandate: "mandate",
  record: "record",
  ack: "ack",
} as const
export type EntityType = (typeof TYPE)[keyof typeof TYPE]

/**
 * Records and acks are handed to this address in the same atomic batch that creates them.
 * Nobody holds its key, so from the block they land nobody can delete them, not even the
 * operator who controls the agent's key. `readonly` blocks edits; `permissionlessExtension`
 * still lets any party keep the evidence alive during a dispute.
 */
export const SEAL_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const

/** Verdicts an agent writes into a record. */
export const VERDICT = { allowed: "allowed", refused: "refused" } as const
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT]

/** Machine-readable reasons. `ok` only ever accompanies `allowed`. */
export const REASON = {
  ok: "ok",
  noLiveMandate: "no_live_mandate",
  wrongAgent: "wrong_agent",
  kindNotAllowed: "kind_not_allowed",
  counterpartyNotAllowed: "counterparty_not_allowed",
  overActionCap: "over_action_cap",
  overDayCap: "over_day_cap",
  invalidAmount: "invalid_amount",
} as const
export type Reason = (typeof REASON)[keyof typeof REASON]

/** Arkiv produces a block every 2 seconds; every lifetime must be a whole number of blocks. */
export const BLOCK_SECONDS = 2

/** Defaults used by the CLI and the demo. Each mandate can override them in its policy. */
export const DEFAULTS = {
  /** A mandate lives this long unless the principal renews it (Lifetime Extension). */
  leaseSeconds: 15 * 60,
  /** Records and acks are kept this long: the dispute window. Anyone may extend it. */
  retentionDays: 45,
  /** Moscow time: the demo fleet counts its daily cap in UTC+3. */
  dayOffsetMinutes: 180,
} as const

/** Tiramisu testnet. */
export const TIRAMISU = {
  chainId: 7738577,
  http: "https://rpc.tiramisu.db-chain.testnet.arkiv.network",
  ws: "wss://rpc.tiramisu.db-chain.testnet.arkiv.network",
  explorer: "https://tiramisu.explorer.arkiv.network",
  dataExplorer: "https://data.arkiv.network",
} as const

/** Content types. Record and ack payloads are AES-256-GCM envelopes serialised as JSON. */
export const CONTENT_TYPE = {
  policy: "application/json",
  sealed: "application/json",
} as const
