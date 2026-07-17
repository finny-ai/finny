import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

const WARMUP_STRATEGY = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.traded = False

    def on_bar(self, symbol, bar):
        history = self.broker.history(symbol, limit=200)
        if len(history) < 200 or self.traded:
            return
        self.broker.buy(symbol, qty=1000000)
        self.traded = True
`

describe("validator smoke window", () => {
  test("runs post-warmup observations for required_history_bars=200", async () => {
    const result = await Validate.run(WARMUP_STRATEGY, {
      config: { symbol: "SPY", required_history_bars: 200 },
    })

    expect(result.errors.map((error) => error.code)).not.toContain("SMOKE_TEST_INCONCLUSIVE")
    expect(result.errors.map((error) => error.code)).toContain("LEVERAGE_VIOLATION")
  })

  test("fails closed when the 5000-bar cap cannot provide a 200-bar probe", async () => {
    const result = await Validate.run(WARMUP_STRATEGY, {
      config: { symbol: "SPY", required_history_bars: 4_900 },
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.code)).toContain("SMOKE_TEST_INCONCLUSIVE")
  })
})
