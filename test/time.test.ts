import { describe, expect, it } from "vitest"
import { blocksLeft, blockToDate, humanDuration, secondsLeft } from "../src/core/time.ts"

describe("lease arithmetic", () => {
  it("counts blocks and seconds left at 2 s per block, never negative", () => {
    expect(blocksLeft(1_450n, 1_000n)).toBe(450n)
    expect(secondsLeft(1_450n, 1_000n)).toBe(900)
    expect(secondsLeft(1_000n, 1_450n)).toBe(0)
  })

  it("prints durations for people", () => {
    expect(humanDuration(0)).toBe("expired")
    expect(humanDuration(845)).toBe("14m 05s")
    expect(humanDuration(3 * 3600 + 7 * 60)).toBe("3h 07m")
    expect(humanDuration(45 * 86_400)).toBe("45d 0h")
  })

  it("maps a block to a wall-clock time from one reference point", () => {
    const ref = { block: 1_000n, timeMs: Date.UTC(2026, 9, 9, 12, 0, 0) }
    expect(blockToDate(1_450n, ref).toISOString()).toBe("2026-10-09T12:15:00.000Z")
    expect(blockToDate(550n, ref).toISOString()).toBe("2026-10-09T11:45:00.000Z")
  })
})
