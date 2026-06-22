import { describe, expect, test } from "bun:test"
import {
  CRUCIBLE_2_0_PRODUCT_LABEL,
  CRUCIBLE_REPRESENTATIVE_RERUNS,
  representativeRerunForAlgorithm,
} from "../../src/backtest/crucible-reruns"

describe("Crucible 2.0 representative reruns", () => {
  test("covers the product rollout strategy set", () => {
    expect(CRUCIBLE_2_0_PRODUCT_LABEL).toBe("Crucible 2.0")
    expect(CRUCIBLE_REPRESENTATIVE_RERUNS.map((r) => r.name)).toEqual([
      "Buy-and-hold BTC",
      "BTC 200-day filter",
      "BTC Donchian/ATR",
      "BTC 4h trend/ATR",
      "SPY intraday crossover",
      "ES futures smoke strategy",
    ])
    expect(CRUCIBLE_REPRESENTATIVE_RERUNS.every((r) => r.gate === "strict_v2")).toBe(true)
  })

  test("resolves by existing immutable algorithm name", () => {
    expect(representativeRerunForAlgorithm("btc-4h-trend-atr")?.name).toBe("BTC 4h trend/ATR")
    expect(representativeRerunForAlgorithm("missing")).toBeUndefined()
  })
})
