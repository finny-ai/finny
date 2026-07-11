import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

// Reproduces the BTC session failure: sizing computed fractionally but clamped
// with max(1, int(...)), forcing a 1-whole-unit order (~$60K) on a $10K account.
// The clamp lives in a helper method, not on_bar — the check must scan the class.
const MIN_CLAMP_STRATEGY = `
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.position_pct = 0.10
        self.closes = deque(maxlen=200)
        self.position = 0
        self.position_qty = 0

    def _get_position_size(self, price):
        equity = self.broker.equity()
        if equity <= 0 or price <= 1e-10:
            return 0
        return max(1, int((equity * self.position_pct) / price))

    def on_bar(self, symbol, bar):
        price = bar["open"]
        if price <= 0:
            return
        self.closes.append(price)
        if len(self.closes) < 21:
            return
        sma = sum(list(self.closes)[-21:-1]) / 20
        if self.position == 0 and price < sma * 0.98:
            qty = self._get_position_size(price)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.position = 1
                self.position_qty = qty
        elif self.position == 1 and price > sma:
            self.broker.sell(symbol, qty=self.position_qty)
            self.position = 0
            self.position_qty = 0
`

const INT_FLOOR_STRATEGY = `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.qty_pct = 0.1

    def _get_position_size(self, price):
        equity = self.broker.equity()
        if equity <= 0 or price <= 0:
            return 0
        return int((equity * self.qty_pct) / price)

    def on_bar(self, symbol, bar):
        price = bar["open"]
        qty = self._get_position_size(price)
        if qty > 0:
            self.broker.buy(symbol, qty=qty)
`

const FRACTIONAL_STRATEGY = `
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.position_pct = 0.10
        self.closes = deque(maxlen=200)
        self.position = 0
        self.position_qty = 0.0

    def _get_position_size(self, price):
        equity = self.broker.equity()
        if equity <= 0 or price <= 1e-10:
            return 0.0
        qty = (equity * self.position_pct) / price
        return round(qty, 6)

    def on_bar(self, symbol, bar):
        price = bar["open"]
        if price <= 0:
            return
        if len(self.closes) >= 21:
            sma = sum(list(self.closes)[-20:]) / 20
            if self.position == 0 and price < sma * 0.98:
                qty = self._get_position_size(price)
                if qty * price >= 10:
                    self.broker.buy(symbol, qty=qty)
                    self.position = 1
                    self.position_qty = qty
            elif self.position == 1 and price > sma:
                self.broker.sell(symbol, qty=self.position_qty)
                self.position = 0
                self.position_qty = 0.0
        self.closes.append(price)
`

describe("crypto whole-unit sizing diagnostics", () => {
  test("flags max(1, int(...)) clamp for a crypto symbol", async () => {
    const result = await Validate.run(MIN_CLAMP_STRATEGY, {
      config: { symbol: "BTC/USD" },
      skipSmokeTest: true,
    })
    const warning = result.warnings.find((w) => w.code === "CRYPTO_WHOLE_UNIT_QTY")
    expect(warning).toBeDefined()
    expect(warning!.message).toContain("whole-unit minimum")
  })

  test("flags int(...) floor inside a sizing helper for a crypto symbol", async () => {
    const result = await Validate.run(INT_FLOOR_STRATEGY, {
      config: { symbol: "ETH-USD" },
      skipSmokeTest: true,
    })
    expect(result.warnings.some((w) => w.code === "CRYPTO_WHOLE_UNIT_QTY")).toBe(true)
  })

  test("does not flag fractional sizing for a crypto symbol", async () => {
    const result = await Validate.run(FRACTIONAL_STRATEGY, {
      config: { symbol: "BTC/USD" },
      skipSmokeTest: true,
    })
    expect(result.warnings.some((w) => w.code === "CRYPTO_WHOLE_UNIT_QTY")).toBe(false)
  })

  test("does not flag int(...) floor for an equity symbol", async () => {
    const result = await Validate.run(INT_FLOOR_STRATEGY, {
      config: { symbol: "SPY" },
      skipSmokeTest: true,
    })
    expect(result.warnings.some((w) => w.code === "CRYPTO_WHOLE_UNIT_QTY")).toBe(false)
  })

  test("smoke test high-price regime catches the clamp as a leverage error", async () => {
    const result = await Validate.run(MIN_CLAMP_STRATEGY, {
      config: { symbol: "BTC/USD" },
    })
    expect(result.valid).toBe(false)
    const violation = result.errors.find((e) => e.code === "LEVERAGE_VIOLATION")
    expect(violation).toBeDefined()
    expect(violation!.message).toContain("high_price")
    expect(violation!.message).toContain("max(1, int(qty))")
  })

  test("treats IBKR dot-quoted crypto as crypto during validation", async () => {
    const result = await Validate.run(MIN_CLAMP_STRATEGY, {
      config: { symbol: "BTC.USD" },
    })
    expect(result.errors.some((e) => e.code === "LEVERAGE_VIOLATION" && e.message.includes("high_price"))).toBe(true)
  })

  test("smoke test does not run the high-price regime for non-crypto symbols", async () => {
    const result = await Validate.run(MIN_CLAMP_STRATEGY, {
      config: { symbol: "SPY" },
    })
    expect(result.errors.some((e) => e.code === "LEVERAGE_VIOLATION" && e.message.includes("high_price"))).toBe(
      false,
    )
  })
})
