import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

describe("Validate lookahead diagnostics", () => {
  test("allows decision-time open and all prior-bar fields", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def on_bar(self, symbol, bar):
        prior = [bar["prev_open"], bar["prev_high"], bar["prev_low"], bar["prev_close"]]
        if all(value is not None for value in prior) and bar["open"] > min(prior):
            self.broker.buy(symbol, qty=1)
      `,
      { skipSmokeTest: true },
    )

    expect(result.errors.map((error) => error.code)).not.toContain("LOOKAHEAD_BIAS_FLOW")
  })

  test("flags current-bar close in on_bar trade decisions", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def on_bar(self, symbol, bar):
        if bar["close"] > 100:
            self.broker.buy(symbol, qty=1)
      `,
      { skipSmokeTest: true },
    )

    expect(result.valid).toBe(false)
    expect(result.errors.some((err) => err.code === "LOOKAHEAD_BIAS_FLOW")).toBe(true)
  })

  test("flags current-bar high/low in on_bar trade decisions", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def on_bar(self, symbol, bar):
        if bar["high"] > 100:
            self.broker.sell(symbol, qty=1)
      `,
      { skipSmokeTest: true },
    )

    expect(result.valid).toBe(false)
    expect(result.errors.some((err) => err.code === "LOOKAHEAD_BIAS_FLOW")).toBe(true)
  })

  test("flags current-bar low in on_bar trade decisions", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker

    def on_bar(self, symbol, bar):
        if bar["low"] < 100:
            self.broker.buy(symbol, qty=1)
      `,
      { skipSmokeTest: true },
    )

    expect(result.errors.some((err) => err.code === "LOOKAHEAD_BIAS_FLOW")).toBe(true)
  })
})
