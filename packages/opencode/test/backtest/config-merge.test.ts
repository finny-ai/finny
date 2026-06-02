import { describe, expect, test } from "bun:test"
import { BacktestRunner } from "../../src/backtest/runner"

describe("BacktestRunner config preflight", () => {
  test("blocks cleanly before Python when symbol is missing", async () => {
    const result = await BacktestRunner.run({
      algorithm: {
        algorithmId: "algo-missing-symbol",
        userId: "user",
        name: "missing-symbol",
        code: "class Strategy:\n    pass\n",
        language: "python",
        version: 1,
        status: "draft",
        config: JSON.stringify({ params: { fast_ma: 10 } }),
        time_created: Date.now(),
        time_updated: Date.now(),
      },
      duration: "1m",
      interval: "1d",
      capital: "10000",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe("config_invalid")
      expect(result.error).toContain("Missing symbol")
    }
  })
})
