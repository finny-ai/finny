export namespace Templates {
  export const TYPES = [
    "momentum",
    "mean-reversion",
    "breakout",
    "golden-cross",
    "macd",
    "atr-breakout",
    "vwap-reversion",
    "z-score",
    "keltner",
    "adx-trend",
    "supertrend",
    "ttm-squeeze",
    "ou-reversion",
    "tsmom-vol",
    "custom",
  ] as const
  export type TemplateType = (typeof TYPES)[number]

  const DESCRIPTIONS: Record<TemplateType, string> = {
    "momentum": "RSI momentum strategy — buys oversold, sells overbought",
    "mean-reversion": "Bollinger Bands mean reversion — buys at lower band, sells at upper",
    "breakout": "Donchian channel breakout — buys new highs, sells new lows",
    "golden-cross": "SMA 50/200 crossover — buys golden cross, sells death cross",
    "macd": "MACD signal-line crossover — trend-following with histogram confirmation",
    "atr-breakout": "ATR volatility breakout — enters on range expansion, exits on contraction",
    "vwap-reversion": "VWAP mean reversion — buys below VWAP, sells above, session-anchored",
    "z-score": "Z-score mean reversion — normalized distance from rolling mean, statistical entry/exit",
    "keltner": "Keltner channel breakout — EMA ± ATR bands, volatility-adaptive",
    "adx-trend": "ADX-filtered trend — only trades when trend strength exceeds threshold",
    "supertrend": "Supertrend — ATR-band trend follower, flips long/flat on band cross",
    "ttm-squeeze": "TTM Squeeze — Bollinger-inside-Keltner compression, fires on volatility release",
    "ou-reversion": "Ornstein-Uhlenbeck reversion — half-life-filtered statistical mean reversion",
    "tsmom-vol": "Vol-targeted time-series momentum — trailing-return signal sized to a volatility target",
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
      case "golden-cross":
        return GOLDEN_CROSS
      case "macd":
        return MACD
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
      case "supertrend":
        return SUPERTREND
      case "ttm-squeeze":
        return TTM_SQUEEZE
      case "ou-reversion":
        return OU_REVERSION
      case "tsmom-vol":
        return TSMOM_VOL
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
  //   - Sizing uses qty = int(min(by_risk, by_cash)) so the validator's leverage smoke
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
        if self.period <= 0:
            return
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
            qty = int(min(by_risk, by_cash))
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
        denom = n
        if denom <= 1:
            self.prices.append(close_px)
            return
        mean = sum(self.prices) / denom
        sample_denom = denom - 1
        if sample_denom <= 0:
            self.prices.append(close_px)
            return
        variance = sum((x - mean) ** 2 for x in self.prices) / sample_denom
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
            qty = int(min(by_risk, by_cash))
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

        if upper_channel <= lower_channel:
            self.highs.append(bar_high)
            self.lows.append(bar_low)
            return

        if pos == 0 and open_px > upper_channel and open_px > 0:
            stop_dist = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
            qty = int(min(by_risk, by_cash))
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif pos > 0 and open_px < lower_channel:
            self.broker.sell(symbol, qty=pos)

        self.highs.append(bar_high)
        self.lows.append(bar_low)
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

        if self.fast_period <= 0 or self.slow_period <= 0 or self.fast_period > self.slow_period:
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
                qty = int(min(by_risk, by_cash))
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
            # Death cross
            elif pos > 0 and not fast_above and self.prev_fast_above:
                self.broker.sell(symbol, qty=pos)

        self.prev_fast_above = fast_above
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
        #     qty = int(min(by_risk, by_cash))
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
        self.macd_values = deque(maxlen=self.signal_period + 5)
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

        if len(self.closes) < self.slow_period or len(self.macd_values) < self.signal_period:
            self.closes.append(close_px)
            vals = list(self.closes)
            fast_ema = self._ema(vals, self.fast_period)
            slow_ema = self._ema(vals, self.slow_period)
            if fast_ema is not None and slow_ema is not None:
                self.macd_values.append(fast_ema - slow_ema)
            return

        # MACD = EMA(fast) - EMA(slow)
        vals = list(self.closes)
        fast_ema = self._ema(vals, self.fast_period)
        slow_ema = self._ema(vals, self.slow_period)
        if fast_ema is None or slow_ema is None:
            return
        macd = fast_ema - slow_ema

        signal = self._ema(self.macd_values, self.signal_period)
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
                qty = int(min(by_risk, by_cash))
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
        self.closes.append(close_px)
        vals = list(self.closes)
        fast_ema = self._ema(vals, self.fast_period)
        slow_ema = self._ema(vals, self.slow_period)
        if fast_ema is not None and slow_ema is not None:
            self.macd_values.append(fast_ema - slow_ema)
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

        if len(self.true_ranges) < self.atr_period:
            self.true_ranges.append(tr)
            self.prev_close = prev_close
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
                qty = int(min(by_risk, by_cash))
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
        self.true_ranges.append(tr)
        self.prev_close = prev_close
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

        if len(self.prices) < self.lookback:
            self.prices.append(prev_close)
            self.volumes.append(max(volume, 1e-10))
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
            self.prices.append(prev_close)
            self.volumes.append(max(volume, 1e-10))
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
            qty = int(min(by_risk, by_cash))
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px
        # Exit: price reverts to VWAP or stop
        elif pos > 0:
            stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
            if z >= 0 or stop_hit:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
        self.prices.append(prev_close)
        self.volumes.append(max(volume, 1e-10))
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

        if len(self.prices) < self.lookback:
            self.prices.append(prev_close)
            return

        n = len(self.prices)
        mean = sum(self.prices) / n
        variance = sum((x - mean) ** 2 for x in self.prices) / (n - 1) if n > 1 else 0.0
        std = math.sqrt(variance)
        if std < 1e-10:
            self.prices.append(prev_close)
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
            qty = int(min(by_risk, by_cash))
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px
        # Exit: z-score reverts past exit threshold or stop
        elif pos > 0:
            stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
            if z >= self.exit_z or stop_hit:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
        self.prices.append(prev_close)
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
        if period <= 0:
            return None
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

        if len(self.true_ranges) < self.atr_period or len(self.closes) < self.ema_period:
            self.true_ranges.append(tr)
            self.closes.append(prev_close)
            self.prev_close = prev_close
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
            qty = int(min(by_risk, by_cash))
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_px = open_px
        # Exit: price drops back to EMA or below lower band
        elif pos > 0:
            if open_px <= ema or open_px <= lower:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0
        self.true_ranges.append(tr)
        self.closes.append(prev_close)
        self.prev_close = prev_close
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
            qty = int(min(by_risk, by_cash))
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

  const SUPERTREND = `\
from collections import deque

class Strategy:
    """Supertrend — ATR-band trend follower.

    Builds an ATR band around the median price (hl2) of completed bars. When
    price closes above the upper band the trend flips up (go long); when it
    closes below the lower band the trend flips down (go flat). The bands
    ratchet in the trend direction so they never loosen mid-trend. Long/flat
    only — the broker contract has no shorting.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.period = int(p.get("period", 10))
        self.mult = float(p.get("mult", 3.0))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.trs = deque(maxlen=self.period)
        self.prev_close_v = None
        self.trend_up = True
        self.final_upper = None
        self.final_lower = None
        self.atr = None
        self.ready = False
        self.entry_px = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        ph = bar["prev_high"]
        pl = bar["prev_low"]
        pc = bar["prev_close"]
        if ph is None or pl is None or pc is None:
            return

        # Trade at the current open using only trend/ATR state settled before
        # this callback. The prev_* bar below updates state for the next open.
        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if self.ready and self.atr is not None:
            if pos == 0 and self.trend_up and open_px > 0:
                stop_dist = self.mult * self.atr
                by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = int(min(by_risk, by_cash))
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.entry_px = open_px
            elif pos > 0 and not self.trend_up:
                self.broker.sell(symbol, qty=pos)
                self.entry_px = 0.0

        # True range from completed bars only
        if self.prev_close_v is not None:
            tr = max(ph - pl, abs(ph - self.prev_close_v), abs(pl - self.prev_close_v))
        else:
            tr = ph - pl
        self.trs.append(tr)
        prev_settled_close = self.prev_close_v
        self.prev_close_v = pc

        if len(self.trs) < self.period:
            return

        self.atr = sum(self.trs) / len(self.trs)
        hl2 = (ph + pl) / 2.0
        basic_upper = hl2 + self.mult * self.atr
        basic_lower = hl2 - self.mult * self.atr

        # Ratchet the bands so they only tighten in the trend direction
        if self.final_upper is None or prev_settled_close is None:
            self.final_upper = basic_upper
            self.final_lower = basic_lower
        else:
            if basic_upper < self.final_upper or prev_settled_close > self.final_upper:
                self.final_upper = basic_upper
            if basic_lower > self.final_lower or prev_settled_close < self.final_lower:
                self.final_lower = basic_lower

        # Flip the trend on a band break, using the last completed close
        if pc > self.final_upper:
            self.trend_up = True
        elif pc < self.final_lower:
            self.trend_up = False
        self.ready = True
`

  const TTM_SQUEEZE = `\
from collections import deque
import math

class Strategy:
    """TTM Squeeze — volatility-compression breakout.

    The squeeze is ON when the Bollinger Bands sit fully inside the Keltner
    Channels (volatility contracting, energy building). The trade fires when
    the squeeze RELEASES (bands expand back outside the channels) in the
    direction of momentum. Enters long on a release with positive momentum;
    exits when momentum rolls over or the stop is hit. Long/flat only.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.period = int(p.get("period", 20))
        self.bb_std = float(p.get("bb_std", 2.0))
        self.kc_mult = float(p.get("kc_mult", 1.5))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.04))
        self.closes = deque(maxlen=self.period)
        self.trs = deque(maxlen=self.period)
        self.prev_close_v = None
        self.squeeze_on = True
        self.release_signal = False
        self.momentum = 0.0
        self.ready = False
        self.entry_px = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        ph = bar["prev_high"]
        pl = bar["prev_low"]
        pc = bar["prev_close"]
        if ph is None or pl is None or pc is None:
            return

        # Execute at the current open from prior-window squeeze/momentum state.
        # The completed bar below updates those signals for the next open.
        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if self.ready:
            if pos == 0 and self.release_signal and self.momentum > 0 and open_px > 0:
                stop_dist = open_px * self.stop_pct
                by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = int(min(by_risk, by_cash))
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.entry_px = open_px
            elif pos > 0:
                stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
                if self.momentum < 0 or stop_hit:
                    self.broker.sell(symbol, qty=pos)
                    self.entry_px = 0.0

        if self.prev_close_v is not None:
            tr = max(ph - pl, abs(ph - self.prev_close_v), abs(pl - self.prev_close_v))
        else:
            tr = ph - pl
        self.closes.append(pc)
        self.trs.append(tr)
        self.prev_close_v = pc

        if len(self.closes) < self.period:
            return

        n = len(self.closes)
        if n <= 1:
            return
        mean = sum(self.closes) / n
        var = sum((x - mean) ** 2 for x in self.closes) / (n - 1)
        std = math.sqrt(var)
        atr = sum(self.trs) / len(self.trs)

        bb_upper = mean + self.bb_std * std
        bb_lower = mean - self.bb_std * std
        kc_upper = mean + self.kc_mult * atr
        kc_lower = mean - self.kc_mult * atr

        was_squeezed = self.squeeze_on
        self.squeeze_on = bb_lower > kc_lower and bb_upper < kc_upper
        self.release_signal = was_squeezed and not self.squeeze_on

        # Momentum: last completed close relative to the window mean
        self.momentum = pc - mean
        self.ready = True
`

  const OU_REVERSION = `\
from collections import deque
import math

class Strategy:
    """Ornstein-Uhlenbeck mean reversion with a half-life regime filter.

    Fits an AR(1) model to the price window to estimate the OU reversion speed
    and its half-life, and trades only when the series is genuinely
    mean-reverting (a finite, short half-life). Enters long when price's
    z-score versus the window mean falls below -entry_z; exits as price reverts
    back toward the mean (z above -exit_z) or the stop is hit. Long/flat only.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.period = int(p.get("period", 30))
        self.entry_z = float(p.get("entry_z", 1.5))
        self.exit_z = float(p.get("exit_z", 0.2))
        self.max_half_life = float(p.get("max_half_life", 20.0))
        self.risk_pct = float(p.get("risk_pct", 0.02))
        self.stop_pct = float(p.get("stop_pct", 0.04))
        self.prices = deque(maxlen=self.period)
        self.ready = False
        self.mean_reverting = False
        self.z_score = 0.0
        self.entry_px = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        pc = bar["prev_close"]
        if pc is None:
            return

        # Execute at the current open from OU state computed before this bar.
        # The completed close below updates z/half-life for the next open.
        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if self.ready and self.mean_reverting:
            if pos == 0 and self.z_score < -self.entry_z and open_px > 0:
                stop_dist = open_px * self.stop_pct
                by_risk = (equity * self.risk_pct) / stop_dist if stop_dist > 0 else 0.0
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = int(min(by_risk, by_cash))
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.entry_px = open_px
            elif pos > 0:
                stop_hit = self.entry_px > 0 and open_px < self.entry_px * (1 - self.stop_pct)
                if self.z_score > -self.exit_z or stop_hit:
                    self.broker.sell(symbol, qty=pos)
                    self.entry_px = 0.0

        self.prices.append(pc)
        self.ready = False
        self.mean_reverting = False
        if len(self.prices) < self.period:
            return

        xs = list(self.prices)
        n = len(xs)
        mean = sum(xs) / n
        var = sum((x - mean) ** 2 for x in xs) / (n - 1) if n > 1 else 0.0
        std = math.sqrt(var)
        if std <= 1e-10:
            return

        # AR(1) half-life: regress delta_t = x_t - x_(t-1) on the lagged level.
        lag = xs[:-1]
        delta = [xs[i] - xs[i - 1] for i in range(1, n)]
        lag_mean = sum(lag) / len(lag)
        delta_mean = sum(delta) / len(delta)
        cov = sum((lag[i] - lag_mean) * (delta[i] - delta_mean) for i in range(len(lag)))
        denom = sum((v - lag_mean) ** 2 for v in lag)
        if denom <= 1e-10:
            return
        beta = cov / denom
        # Mean-reverting only when beta < 0; half-life = -ln(2) / beta.
        if beta >= 0:
            return
        half_life = -math.log(2) / beta
        if half_life <= 0 or half_life > self.max_half_life:
            return

        self.z_score = (pc - mean) / std
        self.mean_reverting = True
        self.ready = True
`

  const TSMOM_VOL = `\
from collections import deque
import math

class Strategy:
    """Vol-targeted time-series momentum (managed-futures style).

    The signal is the sign of the trailing return over the lookback window.
    Position size is scaled so the strategy's expected volatility matches a
    fixed annual target — larger when the market is calm, smaller when it is
    wild — capped at fully invested (no leverage). Long when trailing momentum
    is positive, flat otherwise. Long/flat only.
    """
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.lookback = int(p.get("lookback", 60))
        self.vol_window = int(p.get("vol_window", 20))
        self.target_vol = float(p.get("target_vol", 0.15))
        self.bars_per_year = float(p.get("bars_per_year", 252))
        maxlen = max(self.lookback, self.vol_window) + 2
        self.closes = deque(maxlen=maxlen)
        self.ready = False
        self.momentum = 0.0
        self.ann_vol = 0.0

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        pc = bar["prev_close"]
        if pc is None:
            return

        # Execute at the current open from prior momentum/volatility state.
        # The completed close below updates state for the next open.
        pos = self.broker.position(symbol)
        equity = self.broker.equity()
        cash = self.broker.cash()

        if self.ready:
            if self.momentum > 0 and open_px > 0:
                # Vol-target scalar, capped at fully invested (long-only, no leverage)
                scale = min(self.target_vol / self.ann_vol, 1.0) if self.ann_vol > 1e-6 else 0.0
                by_target = (equity * scale) / open_px
                by_cash = (cash * 0.95) / open_px if cash > 0 else 0.0
                qty = int(min(by_target, by_cash))
                if pos == 0 and qty > 0:
                    self.broker.buy(symbol, qty=qty)
            elif pos > 0 and self.momentum <= 0:
                self.broker.sell(symbol, qty=pos)

        self.closes.append(pc)
        self.ready = False
        need = max(self.lookback, self.vol_window) + 1
        if len(self.closes) < need:
            return

        xs = list(self.closes)
        # Trailing-return momentum over the lookback window
        past = xs[-(self.lookback + 1)]
        if past <= 0:
            return
        self.momentum = xs[-1] / past - 1.0

        # Realized volatility from recent bar-to-bar returns, annualized
        count = 0
        total = 0.0
        total_sq = 0.0
        for i in range(len(xs) - self.vol_window, len(xs)):
            prev = xs[i - 1]
            if prev > 0:
                ret = xs[i] / prev - 1.0
                count += 1
                total += ret
                total_sq += ret * ret
        if count < 2:
            return
        rmean = total / count
        rvar = (total_sq - count * rmean * rmean) / (count - 1)
        self.ann_vol = math.sqrt(max(rvar, 0.0)) * math.sqrt(self.bars_per_year)
        if self.ann_vol <= 1e-6:
            return
        self.ready = True
`
}
