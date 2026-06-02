import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

describe("Validate lookahead diagnostics", () => {
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
})
