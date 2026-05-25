import { describe, expect, test } from "bun:test"
import { BacktestRunner } from "../../src/backtest/runner"
import type { Algorithm } from "../../src/algorithm"

function algo(overrides: Partial<Algorithm.Info> = {}): Algorithm.Info {
  return {
    algorithmId: "algo_test",
    userId: "user",
    name: "test",
    code: "class Strategy:\n    def __init__(self, broker): self.broker = broker\n    def on_bar(self, symbol, bar): pass\n",
    language: "python",
    version: 1,
    status: "draft",
    config: JSON.stringify({ symbol: "AAPL", risk: { starting_equity_usd: 10000 } }),
    time_created: 0,
    time_updated: 0,
    ...overrides,
  }
}

describe("BacktestRunner strict_v2 guardrails", () => {
  test("rejects invalid strategy before any market data subprocess work", async () => {
    const r = await BacktestRunner.run({
      algorithm: algo({
        code: `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        if bar["close"] > bar["open"]:
            self.broker.buy(symbol, qty=1)
`,
      }),
      duration: "1m",
      interval: "1d",
      capital: "10000",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe("validation_failed")
      expect(r.error).toContain("LOOKAHEAD_BIAS_FLOW")
    }
  })

  test("rejects non-finite capital before any subprocess work", async () => {
    const r = await BacktestRunner.run({
      algorithm: algo(),
      duration: "1m",
      interval: "1d",
      capital: "NaN",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("invalid_input")
  })

  test("rejects custom backtestCode in strict_v2 mode", async () => {
    const r = await BacktestRunner.run({
      algorithm: algo({ backtestCode: "print('ann_sharpe: 999')" }),
      duration: "1m",
      interval: "1d",
      capital: "10000",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("unsafe_custom_runner")
  })

  test("rejects legacy_unsafe mode unless explicitly enabled for internal migration", async () => {
    const previous = process.env.FINNY_ALLOW_LEGACY_BACKTEST
    delete process.env.FINNY_ALLOW_LEGACY_BACKTEST
    try {
      const r = await BacktestRunner.run({
        algorithm: algo(),
        duration: "1m",
        interval: "1d",
        capital: "10000",
        engineMode: "legacy_unsafe",
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.kind).toBe("unsafe_custom_runner")
    } finally {
      if (previous === undefined) delete process.env.FINNY_ALLOW_LEGACY_BACKTEST
      else process.env.FINNY_ALLOW_LEGACY_BACKTEST = previous
    }
  })
})
