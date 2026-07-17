import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

const opts = { skipSmokeTest: true } as const

function divisionWarnings(result: Validate.Result) {
  return result.warnings.filter((w) => w.code === "DIVISION_NO_ZERO_CHECK")
}

describe("DIVISION_NO_ZERO_CHECK (AST-based)", () => {
  test("does not flag un-zero-able denominators like period + 1", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def _ema(self, values, period):
        alpha = 2.0 / (period + 1)
        return alpha

    def on_bar(self, symbol, bar):
        return
      `,
      opts,
    )
    expect(divisionWarnings(result)).toEqual([])
  })

  test("does not flag a denominator guarded anywhere in the function", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def _sma(self, total, period):
        if period <= 0:
            return None
        # guard is several lines above the division — the old regex missed this
        adjusted = total * 1.0
        scaled = adjusted * 2.0
        rebased = scaled - adjusted
        return rebased / period

    def on_bar(self, symbol, bar):
        return
      `,
      opts,
    )
    expect(divisionWarnings(result)).toEqual([])
  })

  test("flags a completely unguarded variable denominator with its line", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def _rsi(self, avg_gain, avg_loss):
        rs = avg_gain / avg_loss
        return 100.0 - (100.0 / (1.0 + rs))

    def on_bar(self, symbol, bar):
        return
      `,
      opts,
    )
    const warnings = divisionWarnings(result)
    expect(warnings.length).toBe(1)
    expect(warnings[0].message).toContain("avg_loss")
    expect(warnings[0].line).toBe(7)
  })

  test("reports every offending division, not just the first", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def _ratios(self, a, b, c):
        first = a / b
        second = a / c
        return first + second

    def on_bar(self, symbol, bar):
        return
      `,
      opts,
    )
    expect(divisionWarnings(result).length).toBe(2)
  })

  test("treats max(x, eps) and `or 1` fallback denominators as safe", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def _norm(self, value, spread, volume):
        a = value / max(spread, 1e-10)
        b = value / (volume or 1)
        return a + b

    def on_bar(self, symbol, bar):
        return
      `,
      opts,
    )
    expect(divisionWarnings(result)).toEqual([])
  })
})
