export namespace Templates {
  export type TemplateType = "momentum" | "mean-reversion" | "breakout" | "dca" | "golden-cross" | "scalping" | "custom"

  export const TYPES: TemplateType[] = ["momentum", "mean-reversion", "breakout", "dca", "golden-cross", "scalping", "custom"]

  const DESCRIPTIONS: Record<TemplateType, string> = {
    "momentum": "RSI momentum strategy — buys oversold, sells overbought",
    "mean-reversion": "Bollinger Bands mean reversion — buys at lower band, sells at upper",
    "breakout": "Donchian channel breakout — buys new highs, sells new lows",
    "dca": "Dollar-cost averaging — systematic buying with profit-target exit",
    "golden-cross": "SMA 50/200 crossover — buys golden cross, sells death cross",
    "scalping": "EMA scalping with tight stops — quick entries and exits",
    "custom": "Minimal skeleton — implement your own logic",
  }

  export function describe(type: TemplateType): string {
    return DESCRIPTIONS[type]
  }

  export function get(type: TemplateType): string {
    switch (type) {
      case "momentum":
        return MOMENTUM
      case "mean-reversion":
        return MEAN_REVERSION
      case "breakout":
        return BREAKOUT
      case "dca":
        return DCA
      case "golden-cross":
        return GOLDEN_CROSS
      case "scalping":
        return SCALPING
      case "custom":
        return CUSTOM
    }
  }

  // All templates follow the broker-API contract:
  //   class Strategy:
  //       def __init__(self, broker, params=None): ...
  //       def on_bar(self, symbol, bar): ...
  //
  // Conventions used everywhere:
  //   - bar["open"] is the only price used in trade-gating conditions (no lookahead).
  //   - bar["close"] / bar["high"] / bar["low"] are read AFTER the trade decision,
  //     only to update rolling state for the next bar.
  //   - Sizing uses qty = min(by_risk, by_cash) so the validator's leverage smoke
  //     test (10k starting equity) never sees qty * price > equity.
  //   - Warmup is an early-return guard before any indicator is read.

  const MOMENTUM = `\
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.period = int(p.get("period", 14))
        self.overbought = float(p.get("overbought", 70))
        self.oversold = float(p.get("oversold", 30))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.02))
        self.gains = deque(maxlen=self.period)
        self.losses = deque(maxlen=self.period)
        self.prev_close = None

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["close"]

        # Warmup: collect RSI history from settled prior closes
        if len(self.gains) < self.period:
            if self.prev_close is not None:
                change = close_px - self.prev_close
                if change >= 0:
                    self.gains.append(change)
                    self.losses.append(0.0)
                else:
                    self.gains.append(0.0)
                    self.losses.append(-change)
            self.prev_close = close_px
            return

        # RSI from settled state (no current-bar close in the decision path)
        avg_gain = sum(self.gains) / self.period
        avg_loss = sum(self.losses) / self.period
        if avg_loss > 1e-10:
            rs = avg_gain / avg_loss
            rsi = 100 - (100 / (1 + rs))
        elif avg_gain > 1e-10:
            rsi = 100
        else:
            rsi = 50

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if pos == 0 and rsi < self.oversold and open_px > 0:
            stop_dist = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif pos > 0 and rsi > self.overbought:
            self.broker.sell(symbol, qty=pos)

        # State update — AFTER the trade decision
        if self.prev_close is not None:
            change = close_px - self.prev_close
            if change >= 0:
                self.gains.append(change)
                self.losses.append(0.0)
            else:
                self.gains.append(0.0)
                self.losses.append(-change)
        self.prev_close = close_px
`

  const MEAN_REVERSION = `\
from collections import deque
import math

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.period = int(p.get("period", 20))
        self.num_std = float(p.get("num_std", 2.0))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.02))
        self.prices = deque(maxlen=self.period)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["close"]

        # Warmup: fill prices buffer, no trade decisions yet
        if len(self.prices) < self.period:
            self.prices.append(close_px)
            return

        # Bollinger Bands from settled prior closes
        n = len(self.prices)
        mean = sum(self.prices) / n
        variance = sum((x - mean) ** 2 for x in self.prices) / (n - 1) if n > 1 else 0.0
        std = math.sqrt(variance)

        if std <= 1e-10:
            self.prices.append(close_px)
            return

        lower = mean - self.num_std * std
        upper = mean + self.num_std * std

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if pos == 0 and open_px <= lower and open_px > 0:
            stop_dist = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif pos > 0 and open_px >= upper:
            self.broker.sell(symbol, qty=pos)

        self.prices.append(close_px)
`

  const BREAKOUT = `\
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.period = int(p.get("period", 20))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.03))
        self.highs = deque(maxlen=self.period)
        self.lows = deque(maxlen=self.period)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        # bar["high"]/bar["low"] are read only for state, never for trade-gating
        bar_high = bar["high"]
        bar_low = bar["low"]

        if len(self.highs) < self.period:
            self.highs.append(bar_high)
            self.lows.append(bar_low)
            return

        upper_channel = max(self.highs)
        lower_channel = min(self.lows)

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if pos == 0 and open_px >= upper_channel and open_px > 0:
            stop_dist = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif pos > 0 and open_px <= lower_channel:
            self.broker.sell(symbol, qty=pos)

        self.highs.append(bar_high)
        self.lows.append(bar_low)
`

  const DCA = `\
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.buy_interval = int(p.get("buy_interval", 10))
        self.profit_target = float(p.get("profit_target", 0.05))
        self.dca_pct = float(p.get("dca_pct", 0.10))
        self.tick_count = 0
        self.buy_price_sum = 0.0
        self.buy_count = 0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        self.tick_count += 1

        pos = self.broker.position(symbol)
        cash = self.broker.cash()

        # Exit: avg buy price + profit target reached
        if pos > 0 and self.buy_count > 0:
            avg_price = self.buy_price_sum / self.buy_count
            if avg_price > 0 and open_px >= avg_price * (1 + self.profit_target):
                self.broker.sell(symbol, qty=pos)
                self.buy_price_sum = 0.0
                self.buy_count = 0
                return

        # Buy: every Nth bar, spend a slice of cash
        if self.tick_count % self.buy_interval == 0 and open_px > 0:
            spend = cash * self.dca_pct
            qty = spend / open_px if open_px > 0 else 0.0
            if qty > 0 and spend <= cash:
                self.broker.buy(symbol, qty=qty)
                self.buy_price_sum += open_px
                self.buy_count += 1
`

  const GOLDEN_CROSS = `\
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.fast_period = int(p.get("fast_period", 50))
        self.slow_period = int(p.get("slow_period", 200))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.05))
        self.prices = deque(maxlen=self.slow_period)
        self.prev_fast_above = None

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["close"]

        if len(self.prices) < self.slow_period:
            self.prices.append(close_px)
            return

        prices_list = list(self.prices)
        fast_ma = sum(prices_list[-self.fast_period:]) / self.fast_period
        slow_ma = sum(prices_list) / self.slow_period
        fast_above = fast_ma > slow_ma

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if self.prev_fast_above is not None:
            # Golden cross
            if pos == 0 and fast_above and not self.prev_fast_above and open_px > 0:
                stop_dist = open_px * self.stop_pct
                by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = min(by_risk, by_cash)
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
            # Death cross
            elif pos > 0 and not fast_above and self.prev_fast_above:
                self.broker.sell(symbol, qty=pos)

        self.prev_fast_above = fast_above
        self.prices.append(close_px)
`

  const SCALPING = `\
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.fast_period = int(p.get("fast_period", 8))
        self.slow_period = int(p.get("slow_period", 21))
        self.stop_loss_pct = float(p.get("stop_loss_pct", 0.015))
        self.take_profit_pct = float(p.get("take_profit_pct", 0.01))
        self.risk_pct = float(p.get("risk_pct", 0.01))
        self.prices = deque(maxlen=self.slow_period * 2)
        self.entry_px = 0.0

    def _ema(self, data, period):
        if len(data) < period:
            return None
        prices = list(data)
        multiplier = 2 / (period + 1)
        ema = sum(prices[:period]) / period
        for x in prices[period:]:
            ema = (x - ema) * multiplier + ema
        return ema

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["close"]

        if len(self.prices) < self.slow_period:
            self.prices.append(close_px)
            return

        pos = self.broker.position(symbol)

        # Exit first: tight stop / take-profit measured at the open
        if pos > 0 and self.entry_px > 0:
            move = (open_px - self.entry_px) / self.entry_px if self.entry_px > 0 else 0.0
            if move <= -self.stop_loss_pct or move >= self.take_profit_pct:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
                self.prices.append(close_px)
                return

        # Entry: fast EMA above slow EMA, no position
        fast_ema = self._ema(self.prices, self.fast_period)
        slow_ema = self._ema(self.prices, self.slow_period)
        if fast_ema is not None and slow_ema is not None and pos == 0 and fast_ema > slow_ema and open_px > 0:
            equity = self.broker.equity()
            cash = self.broker.cash()
            stop_dist = open_px * self.stop_loss_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px

        self.prices.append(close_px)
`

  const CUSTOM = `\
from collections import deque

class Strategy:
    """Minimal broker-API skeleton — replace with your strategy logic.

    Broker API:
        self.broker.position(symbol) -> qty held (float, 0 if flat)
        self.broker.equity()         -> total account value
        self.broker.cash()           -> available cash
        self.broker.buy(symbol, qty=N)
        self.broker.sell(symbol, qty=N)

    Bar dict keys: "symbol", "open", "high", "low", "close", "volume", "timestamp"
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.lookback = int(p.get("lookback", 20))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.prices = deque(maxlen=self.lookback)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]    # decision-time safe
        close_px = bar["close"]  # for state updates AFTER the trade decision

        # Warmup
        if len(self.prices) < self.lookback:
            self.prices.append(close_px)
            return

        # ── Indicator math here (read from self.prices / self.* state) ──

        # ── Trade decisions (use open_px + indicators; NEVER use close_px) ──
        # Sizing pattern that satisfies the leverage smoke test:
        #     equity = self.broker.equity()
        #     cash = self.broker.cash()
        #     stop_dist = open_px * 0.02
        #     by_risk = (equity * self.risk_pct) / stop_dist
        #     by_cash = (cash * 0.95) / open_px
        #     qty = min(by_risk, by_cash)
        #     self.broker.buy(symbol, qty=qty)

        # State update at end of bar
        self.prices.append(close_px)
`
}
