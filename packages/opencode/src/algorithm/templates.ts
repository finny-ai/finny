export namespace Templates {
  export type TemplateType = "momentum" | "mean-reversion" | "breakout" | "dca" | "golden-cross" | "scalping" | "macd" | "stochastic" | "atr-breakout" | "vwap-reversion" | "z-score" | "keltner" | "adx-trend" | "custom"

  export const TYPES: TemplateType[] = ["momentum", "mean-reversion", "breakout", "dca", "golden-cross", "scalping", "macd", "stochastic", "atr-breakout", "vwap-reversion", "z-score", "keltner", "adx-trend", "custom"]

  const DESCRIPTIONS: Record<TemplateType, string> = {
    "momentum": "RSI momentum strategy — buys oversold, sells overbought",
    "mean-reversion": "Bollinger Bands mean reversion — buys at lower band, sells at upper",
    "breakout": "Donchian channel breakout — buys new highs, sells new lows",
    "dca": "Dollar-cost averaging — systematic buying with profit-target exit",
    "golden-cross": "SMA 50/200 crossover — buys golden cross, sells death cross",
    "scalping": "EMA scalping with tight stops — quick entries and exits",
    "macd": "MACD signal-line crossover — trend-following with histogram confirmation",
    "stochastic": "Stochastic %K/%D crossover — overbought/oversold with smoothing",
    "atr-breakout": "ATR volatility breakout — enters on range expansion, exits on contraction",
    "vwap-reversion": "VWAP mean reversion — buys below VWAP, sells above, session-anchored",
    "z-score": "Z-score mean reversion — normalized distance from rolling mean, statistical entry/exit",
    "keltner": "Keltner channel breakout — EMA ± ATR bands, volatility-adaptive",
    "adx-trend": "ADX-filtered trend — only trades when trend strength exceeds threshold",
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
      case "macd":
        return MACD
      case "stochastic":
        return STOCHASTIC
      case "atr-breakout":
        return ATR_BREAKOUT
      case "vwap-reversion":
        return VWAP_REVERSION
      case "z-score":
        return Z_SCORE
      case "keltner":
        return KELTNER
      case "adx-trend":
        return ADX_TREND
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
  //   - bar["open"] is the only current-bar price exposed at decision time.
  //   - Indicators use completed data via bar["prev_close"], prev_high/low,
  //     or self.broker.history(symbol, limit).
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
        self.overbought = float(p.get("overbought", 62))
        self.oversold = float(p.get("oversold", 38))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.02))
        self.gains = deque(maxlen=self.period)
        self.losses = deque(maxlen=self.period)
        self.prev_close = None

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["prev_close"]
        if close_px is None:
            return

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
        self.num_std = float(p.get("num_std", 1.5))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.02))
        self.prices = deque(maxlen=self.period)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["prev_close"]
        if close_px is None:
            return

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
        bar_high = bar["prev_high"]
        bar_low = bar["prev_low"]
        if bar_high is None or bar_low is None:
            return

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
        self.slow_period = int(p.get("slow_period", 100))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.05))
        self.prices = deque(maxlen=self.slow_period)
        self.prev_fast_above = None

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["prev_close"]
        if close_px is None:
            return

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
        close_px = bar["prev_close"]
        if close_px is None:
            return

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

    Bar dict keys: "symbol", "open", "volume", "timestamp", "prev_open",
    "prev_high", "prev_low", "prev_close"
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.lookback = int(p.get("lookback", 20))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.prices = deque(maxlen=self.lookback)

    def on_bar(self, symbol, bar):
        open_px = bar["open"]    # decision-time safe
        close_px = bar["prev_close"]  # completed prior close for indicators
        if close_px is None:
            return

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

  const MACD = `\
from collections import deque

class Strategy:
    """MACD signal-line crossover with histogram confirmation.

    Entry: MACD line crosses above signal line AND histogram > 0 (bullish momentum).
    Exit: MACD crosses below signal OR histogram turns negative.
    Uses EMA(12), EMA(26), signal EMA(9) — all from settled closes.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.fast_period = int(p.get("fast_period", 12))
        self.slow_period = int(p.get("slow_period", 26))
        self.signal_period = int(p.get("signal_period", 9))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.03))
        self.closes = deque(maxlen=self.slow_period + self.signal_period + 10)
        self.prev_macd_above = None
        self.entry_px = 0.0

    def _ema(self, data, period):
        if len(data) < period:
            return None
        vals = list(data)
        k = 2.0 / (period + 1)
        ema = sum(vals[:period]) / period
        for v in vals[period:]:
            ema = v * k + ema * (1 - k)
        return ema

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["prev_close"]
        if close_px is None:
            return

        self.closes.append(close_px)
        if len(self.closes) < self.slow_period + self.signal_period:
            return

        # MACD = EMA(fast) - EMA(slow)
        vals = list(self.closes)
        fast_ema = self._ema(vals, self.fast_period)
        slow_ema = self._ema(vals, self.slow_period)
        if fast_ema is None or slow_ema is None:
            return
        macd = fast_ema - slow_ema

        # Signal line = EMA of MACD values (approximate: use recent closes to rebuild)
        # For a template, we compute a rolling MACD series then EMA it
        macd_series = []
        for i in range(self.signal_period + 5, len(vals) + 1):
            sub = vals[:i]
            fe = self._ema(sub, self.fast_period)
            se = self._ema(sub, self.slow_period)
            if fe is not None and se is not None:
                macd_series.append(fe - se)
        if len(macd_series) < self.signal_period:
            return
        signal = self._ema(macd_series, self.signal_period)
        if signal is None:
            return
        histogram = macd - signal
        macd_above = macd > signal

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if self.prev_macd_above is not None:
            # Bullish crossover: MACD crosses above signal + histogram positive
            if pos == 0 and macd_above and not self.prev_macd_above and histogram > 0 and open_px > 0:
                stop_dist = open_px * self.stop_pct
                by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = min(by_risk, by_cash)
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.entry_px = open_px
            # Bearish crossover or stop
            elif pos > 0:
                stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
                if (not macd_above and self.prev_macd_above) or stop_hit:
                    self.broker.sell(symbol, qty=pos)
                    self.entry_px = 0.0

        self.prev_macd_above = macd_above
`

  const STOCHASTIC = `\
from collections import deque

class Strategy:
    """Stochastic %K/%D crossover — overbought/oversold with smoothing.

    %K = (close - lowest_low) / (highest_high - lowest_low) * 100
    %D = SMA(%K, d_period)
    Entry: %K crosses above %D from oversold zone (< 20).
    Exit: %K crosses below %D from overbought zone (> 80) OR stop loss.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.k_period = int(p.get("k_period", 14))
        self.d_period = int(p.get("d_period", 3))
        self.oversold = float(p.get("oversold", 20.0))
        self.overbought = float(p.get("overbought", 80.0))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.03))
        self.highs = deque(maxlen=self.k_period)
        self.lows = deque(maxlen=self.k_period)
        self.k_values = deque(maxlen=self.d_period)
        self.prev_k = None
        self.prev_d = None
        self.entry_px = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        prev_high = bar["prev_high"]
        prev_low = bar["prev_low"]
        prev_close = bar["prev_close"]
        if prev_high is None or prev_low is None or prev_close is None:
            return

        self.highs.append(prev_high)
        self.lows.append(prev_low)

        if len(self.highs) < self.k_period:
            return

        highest = max(self.highs)
        lowest = min(self.lows)
        rng = highest - lowest
        if rng < 1e-10:
            return

        k = ((prev_close - lowest) / rng) * 100.0
        self.k_values.append(k)

        if len(self.k_values) < self.d_period:
            return

        d = sum(self.k_values) / self.d_period

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if self.prev_k is not None and self.prev_d is not None:
            # Bullish: %K crosses above %D from oversold
            k_crossed_up = self.prev_k <= self.prev_d and k > d
            if pos == 0 and k_crossed_up and k < 50 and open_px > 0:
                stop_dist = open_px * self.stop_pct
                by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = min(by_risk, by_cash)
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.entry_px = open_px
            # Bearish: %K crosses below %D from overbought OR stop
            elif pos > 0:
                k_crossed_down = self.prev_k >= self.prev_d and k < d
                stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
                if (k_crossed_down and k > 50) or stop_hit:
                    self.broker.sell(symbol, qty=pos)
                    self.entry_px = 0.0

        self.prev_k = k
        self.prev_d = d
`

  const ATR_BREAKOUT = `\
from collections import deque
import math

class Strategy:
    """ATR volatility breakout — enters on range expansion, ATR-based stops.

    Entry: price breaks above (prev_close + atr_mult * ATR) — volatility expansion.
    Exit: price drops below (entry - atr_mult * ATR) — trailing ATR stop.
    ATR adapts to current volatility so stops widen in volatile markets, tighten in calm.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.atr_period = int(p.get("atr_period", 14))
        self.entry_mult = float(p.get("entry_mult", 1.5))
        self.stop_mult = float(p.get("stop_mult", 2.0))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.true_ranges = deque(maxlen=self.atr_period)
        self.prev_close = None
        self.entry_px = 0.0
        self.trailing_stop = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        prev_high = bar["prev_high"]
        prev_low = bar["prev_low"]
        prev_close = bar["prev_close"]
        if prev_high is None or prev_low is None or prev_close is None:
            return

        # True range
        if self.prev_close is not None:
            tr = max(prev_high - prev_low,
                     abs(prev_high - self.prev_close),
                     abs(prev_low - self.prev_close))
        else:
            tr = prev_high - prev_low
        self.true_ranges.append(tr)
        self.prev_close = prev_close

        if len(self.true_ranges) < self.atr_period:
            return

        atr = sum(self.true_ranges) / self.atr_period

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if pos == 0 and open_px > 0:
            # Entry: price breaks above prev_close + entry_mult * ATR
            breakout_level = prev_close + self.entry_mult * atr
            if open_px >= breakout_level:
                stop_dist = self.stop_mult * atr
                by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = min(by_risk, by_cash)
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.entry_px = open_px
                    self.trailing_stop = open_px - self.stop_mult * atr
        elif pos > 0:
            # Update trailing stop: ratchet up, never down
            new_stop = open_px - self.stop_mult * atr
            if new_stop > self.trailing_stop:
                self.trailing_stop = new_stop
            if open_px <= self.trailing_stop:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
                self.trailing_stop = 0.0
`

  const VWAP_REVERSION = `\
from collections import deque

class Strategy:
    """VWAP mean reversion — buys below VWAP, sells above.

    Computes a rolling VWAP (volume-weighted average price) over a lookback window.
    Entry: price drops below VWAP by dev_thresh standard deviations.
    Exit: price reverts to or above VWAP, or stop loss.
    Best on range-bound / high-volume assets.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.lookback = int(p.get("lookback", 20))
        self.dev_thresh = float(p.get("dev_thresh", 1.5))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.03))
        self.prices = deque(maxlen=self.lookback)
        self.volumes = deque(maxlen=self.lookback)
        self.entry_px = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        prev_close = bar["prev_close"]
        volume = bar["volume"]
        if prev_close is None or volume is None:
            return

        self.prices.append(prev_close)
        self.volumes.append(max(volume, 1e-10))

        if len(self.prices) < self.lookback:
            return

        # VWAP = sum(price * volume) / sum(volume)
        pv_sum = sum(p * v for p, v in zip(self.prices, self.volumes))
        v_sum = sum(self.volumes)
        vwap = pv_sum / v_sum if v_sum > 0 else prev_close

        # Standard deviation of price around VWAP
        import math
        sq_dev = sum((p - vwap) ** 2 * v for p, v in zip(self.prices, self.volumes))
        vwap_std = math.sqrt(sq_dev / v_sum) if v_sum > 0 else 1e-10

        if vwap_std < 1e-10:
            return

        z = (open_px - vwap) / vwap_std

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        # Entry: price is dev_thresh std devs below VWAP
        if pos == 0 and z < -self.dev_thresh and open_px > 0:
            stop_dist = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px
        # Exit: price reverts to VWAP or stop
        elif pos > 0:
            stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
            if z >= 0 or stop_hit:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
`

  const Z_SCORE = `\
from collections import deque
import math

class Strategy:
    """Z-score mean reversion — normalized distance from rolling mean.

    Z = (price - mean) / std. Entry when z < -entry_z (statistically cheap).
    Exit when z > exit_z (reverted to or past mean) or stop loss.
    More rigorous than Bollinger — z-score is unit-free and comparable across assets.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.lookback = int(p.get("lookback", 30))
        self.entry_z = float(p.get("entry_z", -2.0))
        self.exit_z = float(p.get("exit_z", 0.0))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.04))
        self.prices = deque(maxlen=self.lookback)
        self.entry_px = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        prev_close = bar["prev_close"]
        if prev_close is None:
            return

        self.prices.append(prev_close)
        if len(self.prices) < self.lookback:
            return

        n = len(self.prices)
        mean = sum(self.prices) / n
        variance = sum((x - mean) ** 2 for x in self.prices) / (n - 1) if n > 1 else 0.0
        std = math.sqrt(variance)
        if std < 1e-10:
            return

        z = (open_px - mean) / std

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        # Entry: z-score below entry threshold (e.g., -2.0 = 2 std devs cheap)
        if pos == 0 and z < self.entry_z and open_px > 0:
            stop_dist = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px
        # Exit: z-score reverts past exit threshold or stop
        elif pos > 0:
            stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
            if z >= self.exit_z or stop_hit:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
`

  const KELTNER = `\
from collections import deque
import math

class Strategy:
    """Keltner channel breakout — EMA center ± ATR-based bands.

    Unlike Bollinger (std dev), Keltner uses ATR for band width — adapts to
    actual price range, not just close-to-close variance.
    Entry: price breaks above upper band (EMA + mult * ATR).
    Exit: price drops below EMA (mean reversion) or trailing ATR stop.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.ema_period = int(p.get("ema_period", 20))
        self.atr_period = int(p.get("atr_period", 14))
        self.atr_mult = float(p.get("atr_mult", 1.5))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.closes = deque(maxlen=self.ema_period + 10)
        self.true_ranges = deque(maxlen=self.atr_period)
        self.prev_close = None
        self.entry_px = 0.0

    def _ema(self, data, period):
        if len(data) < period:
            return None
        vals = list(data)
        k = 2.0 / (period + 1)
        ema = sum(vals[:period]) / period
        for v in vals[period:]:
            ema = v * k + ema * (1 - k)
        return ema

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        prev_high = bar["prev_high"]
        prev_low = bar["prev_low"]
        prev_close = bar["prev_close"]
        if prev_high is None or prev_low is None or prev_close is None:
            return

        # True range
        if self.prev_close is not None:
            tr = max(prev_high - prev_low,
                     abs(prev_high - self.prev_close),
                     abs(prev_low - self.prev_close))
        else:
            tr = prev_high - prev_low
        self.true_ranges.append(tr)
        self.closes.append(prev_close)
        self.prev_close = prev_close

        if len(self.true_ranges) < self.atr_period or len(self.closes) < self.ema_period:
            return

        ema = self._ema(self.closes, self.ema_period)
        atr = sum(self.true_ranges) / self.atr_period
        if ema is None or atr < 1e-10:
            return

        upper = ema + self.atr_mult * atr
        lower = ema - self.atr_mult * atr

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        # Entry: breakout above upper Keltner band
        if pos == 0 and open_px >= upper and open_px > 0:
            stop_dist = self.atr_mult * atr
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px
        # Exit: price drops back to EMA or below lower band
        elif pos > 0:
            if open_px <= ema or open_px <= lower:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
`

  const ADX_TREND = `\
from collections import deque

class Strategy:
    """ADX-filtered trend strategy — only trades when trend is strong.

    ADX (Average Directional Index) measures trend STRENGTH, not direction.
    +DI/-DI give direction. Entry: ADX > threshold AND +DI > -DI (uptrend).
    Exit: ADX drops below threshold (trend weakening) or +DI < -DI (reversal).
    Filters out choppy, range-bound markets where most trend strategies bleed.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.period = int(p.get("period", 14))
        self.adx_threshold = float(p.get("adx_threshold", 25.0))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.04))
        self.highs = deque(maxlen=self.period + 5)
        self.lows = deque(maxlen=self.period + 5)
        self.closes = deque(maxlen=self.period + 5)
        self.prev_close = None
        self.entry_px = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        prev_high = bar["prev_high"]
        prev_low = bar["prev_low"]
        prev_close = bar["prev_close"]
        if prev_high is None or prev_low is None or prev_close is None:
            return

        self.highs.append(prev_high)
        self.lows.append(prev_low)
        self.closes.append(prev_close)

        if len(self.highs) < self.period + 1:
            self.prev_close = prev_close
            return

        hl = list(self.highs)
        ll = list(self.lows)
        cl = list(self.closes)
        n = len(hl)

        # Compute +DM, -DM, TR over the period
        plus_dm_sum = 0.0
        minus_dm_sum = 0.0
        tr_sum = 0.0
        for i in range(1, min(self.period + 1, n)):
            up_move = hl[-(i)] - hl[-(i+1)] if i + 1 <= n else 0.0
            down_move = ll[-(i+1)] - ll[-(i)] if i + 1 <= n else 0.0
            plus_dm = up_move if up_move > down_move and up_move > 0 else 0.0
            minus_dm = down_move if down_move > up_move and down_move > 0 else 0.0
            plus_dm_sum += plus_dm
            minus_dm_sum += minus_dm
            h_l = hl[-(i)] - ll[-(i)]
            h_pc = abs(hl[-(i)] - cl[-(i+1)]) if i + 1 <= n else 0.0
            l_pc = abs(ll[-(i)] - cl[-(i+1)]) if i + 1 <= n else 0.0
            tr_sum += max(h_l, h_pc, l_pc)

        if tr_sum < 1e-10:
            self.prev_close = prev_close
            return

        plus_di = 100.0 * plus_dm_sum / tr_sum
        minus_di = 100.0 * minus_dm_sum / tr_sum
        di_sum = plus_di + minus_di
        dx = 100.0 * abs(plus_di - minus_di) / di_sum if di_sum > 0 else 0.0
        # Simplified ADX ≈ DX (true ADX is smoothed DX over N periods;
        # this is a single-period approximation for template simplicity)
        adx = dx

        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        # Entry: strong trend (ADX > threshold) AND bullish (+DI > -DI)
        if pos == 0 and adx > self.adx_threshold and plus_di > minus_di and open_px > 0:
            stop_dist = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = min(by_risk, by_cash)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px
        # Exit: trend weakens OR direction flips OR stop
        elif pos > 0:
            stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
            if adx < self.adx_threshold or plus_di < minus_di or stop_hit:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0

        self.prev_close = prev_close
`
}
