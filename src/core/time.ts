import { BLOCK_SECONDS } from "./constants.ts"

/** Blocks left until `expiresAt`, never negative. */
export function blocksLeft(expiresAt: bigint, head: bigint): bigint {
  return expiresAt > head ? expiresAt - head : 0n
}

/** Approximate seconds until `expiresAt` at the nominal 2-second block time. */
export function secondsLeft(expiresAt: bigint, head: bigint): number {
  return Number(blocksLeft(expiresAt, head)) * BLOCK_SECONDS
}

/** "14m 05s", "3d 4h", "expired". */
export function humanDuration(seconds: number): string {
  if (seconds <= 0) return "expired"
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  return `${m}m ${String(s).padStart(2, "0")}s`
}

/** Approximate wall-clock date of a future or past block, from one known (block, time) pair. */
export function blockToDate(block: bigint, ref: { block: bigint; timeMs: number }): Date {
  return new Date(ref.timeMs + Number(block - ref.block) * BLOCK_SECONDS * 1000)
}
