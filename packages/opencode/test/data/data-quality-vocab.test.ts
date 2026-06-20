import { describe, expect, test } from "bun:test"
import { isValidOhlcBar, OHLC_VALIDATION_RULE } from "../../src/data/data-quality-vocab"

describe("OHLC validation", () => {
  test("accepts bullish and bearish candles", () => {
    expect(isValidOhlcBar(251.79, 252.17, 249.91, 251.52)).toBe(true)
    expect(isValidOhlcBar(252.37, 252.78, 252.02, 252.78)).toBe(true)
    expect(isValidOhlcBar(100, 101, 98, 98)).toBe(true)
  })

  test("rejects true OHLC violations", () => {
    expect(isValidOhlcBar(100, 99, 98, 97)).toBe(false)
    expect(isValidOhlcBar(100, 101, 102, 100)).toBe(false)
  })

  test("documents the canonical rule", () => {
    expect(OHLC_VALIDATION_RULE).toContain("high >= max(open, close)")
    expect(OHLC_VALIDATION_RULE).toContain("low <= min(open, close)")
  })
})
