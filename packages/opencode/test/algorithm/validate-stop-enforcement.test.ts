import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

// Reproduces the 2026-07-09 headless-run failure: mission.md documented a 5%
// stop, but stop_pct only fed position sizing — no comparison ever triggered a
// stop exit, so downtrend trades rode the falling SMA to a 12% win rate.
const SIZING_ONLY_STOP = `
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.sma_period = int(p.get("sma_period", 20))
        self.entry_dev = float(p.get("entry_dev", 0.0015))
        self.exit_dev = float(p.get("exit_dev", 0.0003))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.05))
        self.prices = deque(maxlen=self.sma_period)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["prev_close"]

        if len(self.prices) < self.sma_period:
            if close_px is not None:
                self.prices.append(close_px)
            return

        sma = sum(self.prices) / self.sma_period
        deviation = (close_px - sma) / sma if sma > 0 else 0

        pos = self.broker.position(symbol)
        equity = self.broker.equity()

        if pos == 0 and deviation <= -self.entry_dev and open_px > 0:
            stop_dist = open_px * self.stop_pct
            risk_amount = equity * self.risk_pct
            by_risk = risk_amount / stop_dist if stop_dist > 0 else 0.0
            by_cash = (equity * 0.95) / open_px
            qty = int(min(by_risk, by_cash))
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif pos > 0 and deviation >= -self.exit_dev:
            self.broker.sell(symbol, qty=pos)

        self.prices.append(close_px)
`

// Same concept, but the stop is real: entry price is tracked and the stop
// level is compared against the bar before the signal exit.
const ENFORCED_STOP = `
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.sma_period = int(p.get("sma_period", 20))
        self.entry_dev = float(p.get("entry_dev", 0.0015))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.05))
        self.entry_price = None
        self.prices = deque(maxlen=self.sma_period)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["prev_close"]

        if len(self.prices) < self.sma_period:
            if close_px is not None:
                self.prices.append(close_px)
            return

        sma = sum(self.prices) / self.sma_period
        deviation = (close_px - sma) / sma if sma > 0 else 0

        pos = self.broker.position(symbol)
        equity = self.broker.equity()

        if pos > 0 and self.entry_price is not None:
            stop_level = self.entry_price * (1.0 - self.stop_pct)
            if open_px <= stop_level:
                self.broker.sell(symbol, qty=pos)
                self.entry_price = None
                self.prices.append(close_px)
                return

        if pos == 0 and deviation <= -self.entry_dev and open_px > 0:
            stop_dist = open_px * self.stop_pct
            risk_amount = equity * self.risk_pct
            by_cash = (equity * 0.95) / open_px
            qty = int(min(risk_amount / stop_dist if stop_dist > 0 else 0.0, by_cash))
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_price = open_px
        elif pos > 0 and deviation >= 0:
            self.broker.sell(symbol, qty=pos)
            self.entry_price = None

        self.prices.append(close_px)
`

// Trailing-stop idiom: the stop level lives on self and ratchets up; the
// comparison against it must count as enforcement.
const TRAILING_STOP = `
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.lookback = int(p.get("lookback", 20))
        self.stop_frac = float(p.get("stop_frac", 0.97))
        self.stop_price = None
        self.prices = deque(maxlen=self.lookback)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        pos = self.broker.position(symbol)

        if pos > 0:
            self.stop_price = max(self.stop_price, open_px * self.stop_frac)
            if open_px < self.stop_price:
                self.broker.sell(symbol, qty=pos)
                self.stop_price = None
                return

        if len(self.prices) >= self.lookback and pos == 0:
            high = max(self.prices)
            if open_px > high:
                equity = self.broker.equity()
                qty = int((equity * 0.5) / open_px)
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.stop_price = open_px * self.stop_frac

        self.prices.append(open_px)
`

// No stop-named parameter at all: the check must stay silent (the design may
// be poor, but that is the prompt's job, not a false positive here).
const NO_STOP_PARAM = `
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.fast = int(p.get("fast", 10))
        self.slow = int(p.get("slow", 30))
        self.prices = deque(maxlen=self.slow)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        if len(self.prices) >= self.slow:
            fast_ma = sum(list(self.prices)[-self.fast:]) / self.fast
            slow_ma = sum(self.prices) / self.slow
            pos = self.broker.position(symbol)
            if pos == 0 and fast_ma > slow_ma:
                equity = self.broker.equity()
                qty = int((equity * 0.5) / open_px)
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
            elif pos > 0 and fast_ma < slow_ma:
                self.broker.sell(symbol, qty=pos)
        self.prices.append(open_px)
`

const CONFIG = { symbol: "SPY", asset_class: "equity", interval: "5min" }

function codes(result: Validate.Result) {
  return [...result.errors, ...result.warnings].map((d) => d.code)
}

describe("STOP_PARAM_NOT_ENFORCED", () => {
  test("flags a stop param that only feeds position sizing", async () => {
    const result = await Validate.run(SIZING_ONLY_STOP, { config: CONFIG, skipSmokeTest: true })
    expect(codes(result)).toContain("STOP_PARAM_NOT_ENFORCED")
  })

  test("passes when the stop level is compared against the bar", async () => {
    const result = await Validate.run(ENFORCED_STOP, { config: CONFIG, skipSmokeTest: true })
    expect(codes(result)).not.toContain("STOP_PARAM_NOT_ENFORCED")
  })

  test("passes a trailing stop tracked on self", async () => {
    const result = await Validate.run(TRAILING_STOP, { config: CONFIG, skipSmokeTest: true })
    expect(codes(result)).not.toContain("STOP_PARAM_NOT_ENFORCED")
  })

  test("stays silent when no stop-named parameter exists", async () => {
    const result = await Validate.run(NO_STOP_PARAM, { config: CONFIG, skipSmokeTest: true })
    expect(codes(result)).not.toContain("STOP_PARAM_NOT_ENFORCED")
  })
})
