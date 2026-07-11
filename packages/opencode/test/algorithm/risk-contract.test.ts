import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

const config = (mode: "none" | "strategy_next_open" | "engine_stop") => ({
  symbol: "SPY",
  asset_class: "equity",
  risk_contract: {
    sizing_stop_distance_pct: 2,
    protective_stop: { mode },
    drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 10 },
    max_positions: 1,
  },
})

const strategy = (body: string) => `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.stop_price = 90.0

    def on_bar(self, symbol, bar):
${body}
`

describe("schema-v4 protective-stop capability", () => {
  test("accepts a strategy_next_open declaration with guarded broker-exit evidence", async () => {
    const result = await Validate.run(
      strategy(`        if bar["open"] <= self.stop_price:
            self.broker.sell(symbol)`),
      { config: config("strategy_next_open"), skipSmokeTest: true },
    )
    expect(result.errors.map((error) => error.code)).not.toContain("PROTECTIVE_STOP_CAPABILITY_MISSING")
    expect(result.capabilities?.protectiveStop).toEqual({ mode: "strategy_next_open", astVerified: true })
  })

  test("blocks a strategy_next_open declaration without AST evidence", async () => {
    const result = await Validate.run(
      strategy(`        if bar["open"] > 0:
            return None`),
      { config: config("strategy_next_open"), skipSmokeTest: true },
    )
    expect(result.errors.map((error) => error.code)).toContain("PROTECTIVE_STOP_CAPABILITY_MISSING")
    expect(result.capabilities?.protectiveStop.astVerified).toBe(false)
  })

  test("does not accept a guarded broker.buy as protective-stop evidence", async () => {
    const result = await Validate.run(
      strategy(`        if bar["open"] <= self.stop_price:
            self.broker.buy(symbol, qty=1)`),
      { config: config("strategy_next_open"), skipSmokeTest: true },
    )
    expect(result.errors.map((error) => error.code)).toContain("PROTECTIVE_STOP_CAPABILITY_MISSING")
    expect(result.capabilities?.protectiveStop.astVerified).toBe(false)
  })

  test("blocks unsupported engine_stop claims independently of strategy code", async () => {
    const result = await Validate.run(
      strategy(`        if bar["open"] <= self.stop_price:
            self.broker.sell(symbol)`),
      { config: config("engine_stop"), skipSmokeTest: true },
    )
    expect(result.errors.map((error) => error.code)).toContain("UNSUPPORTED_ENGINE_STOP")
    expect(result.capabilities?.protectiveStop).toEqual({ mode: "engine_stop", astVerified: false })
  })
})
