import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

const SHORT_ONLY_RANDOM_ENTRY = `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.entry_threshold = 0.001

    def on_bar(self, symbol, bar):
        previous = bar["prev_close"]
        if self.broker.position(symbol) == 0 and previous and bar["open"] < previous * (1 - self.entry_threshold):
            self.broker.sell(symbol, qty=1)
`

const NEVER_ENTERS = `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.entry_threshold = 999.0

    def on_bar(self, symbol, bar):
        if bar["prev_close"] and bar["open"] > bar["prev_close"] * self.entry_threshold:
            self.broker.buy(symbol, qty=1)
`

const DEFAULT_QTY_ENTRY = `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.entry_threshold = 0.001

    def on_bar(self, symbol, bar):
        previous = bar["prev_close"]
        if self.broker.position(symbol) == 0 and previous and bar["open"] < previous * (1 - self.entry_threshold):
            self.broker.buy(symbol)
`

describe("GUARD_NEVER_BINDING", () => {
  test("does not reject a short-only strategy that opens exposure", async () => {
    const result = await Validate.run(SHORT_ONLY_RANDOM_ENTRY, { config: { symbol: "SPY" } })
    expect(result.errors.map((diagnostic) => diagnostic.code)).not.toContain("GUARD_NEVER_BINDING")
    expect(result.warnings.map((diagnostic) => diagnostic.code)).not.toContain("GUARD_NEVER_BINDING")
  })

  test("counts default-sized broker entries", async () => {
    const result = await Validate.run(DEFAULT_QTY_ENTRY, { config: { symbol: "SPY" } })
    expect(result.warnings.map((diagnostic) => diagnostic.code)).not.toContain("GUARD_NEVER_BINDING")
  })

  test("still rejects a thresholded strategy that never enters", async () => {
    const result = await Validate.run(NEVER_ENTERS, { config: { symbol: "SPY" } })
    expect(result.warnings.map((diagnostic) => diagnostic.code)).toContain("GUARD_NEVER_BINDING")
  })
})
