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

  const MOMENTUM = `\
from collections import deque

class Strategy:
    def __init__(self):
        self.period = 14
        self.overbought = 70
        self.oversold = 30
        self.gains = deque(maxlen=self.period)
        self.losses = deque(maxlen=self.period)
        self.prev_price = None

    def on_tick(self, bar):
        price = bar["open"]

        if self.prev_price is None:
            self.prev_price = price
            return "HOLD"

        change = price - self.prev_price
        self.prev_price = price

        if change >= 0:
            self.gains.append(change)
            self.losses.append(0.0)
        else:
            self.gains.append(0.0)
            self.losses.append(abs(change))

        if len(self.gains) < self.period:
            return "HOLD"

        avg_gain = sum(self.gains) / self.period
        avg_loss = sum(self.losses) / self.period

        if avg_loss != 0:
            rs = avg_gain / avg_loss
            rsi = 100 - (100 / (1 + rs))
        else:
            rsi = 100

        if rsi < self.oversold:
            return "BUY"
        if rsi > self.overbought:
            return "SELL"
        return "HOLD"
`

  const MEAN_REVERSION = `\
from collections import deque
import math

class Strategy:
    def __init__(self):
        self.period = 20
        self.num_std = 2.0
        self.prices = deque(maxlen=self.period)

    def on_tick(self, bar):
        price = bar["open"]
        self.prices.append(price)

        if len(self.prices) < self.period:
            return "HOLD"

        mean = sum(self.prices) / self.period
        variance = sum((p - mean) ** 2 for p in self.prices) / self.period
        std = math.sqrt(variance)

        if std != 0:
            lower_band = mean - self.num_std * std
            upper_band = mean + self.num_std * std
        else:
            return "HOLD"

        if price <= lower_band:
            return "BUY"
        if price >= upper_band:
            return "SELL"
        return "HOLD"
`

  const BREAKOUT = `\
from collections import deque

class Strategy:
    def __init__(self):
        self.period = 20
        self.highs = deque(maxlen=self.period)
        self.lows = deque(maxlen=self.period)

    def on_tick(self, bar):
        price = bar["open"]
        high = bar["high"]
        low = bar["low"]

        self.highs.append(high)
        self.lows.append(low)

        if len(self.highs) < self.period:
            return "HOLD"

        upper_channel = max(self.highs)
        lower_channel = min(self.lows)

        if price >= upper_channel:
            return "BUY"
        if price <= lower_channel:
            return "SELL"
        return "HOLD"
`

  const DCA = `\
class Strategy:
    def __init__(self):
        self.tick_count = 0
        self.buy_interval = 10
        self.profit_target = 0.05
        self.buy_price_sum = 0.0
        self.buy_count = 0

    def on_tick(self, bar):
        price = bar["open"]
        self.tick_count += 1

        if self.buy_count > 0:
            avg_price = self.buy_price_sum / self.buy_count
            if avg_price != 0:
                profit = (price - avg_price) / avg_price
                if profit >= self.profit_target:
                    self.buy_price_sum = 0.0
                    self.buy_count = 0
                    return "SELL"

        if self.tick_count % self.buy_interval == 0:
            self.buy_price_sum += price
            self.buy_count += 1
            return "BUY"

        return "HOLD"
`

  const GOLDEN_CROSS = `\
from collections import deque

class Strategy:
    def __init__(self):
        self.fast_period = 50
        self.slow_period = 200
        self.prices = deque(maxlen=self.slow_period)
        self.prev_fast_above = None

    def on_tick(self, bar):
        price = bar["open"]
        self.prices.append(price)

        if len(self.prices) < self.slow_period:
            return "HOLD"

        prices_list = list(self.prices)
        fast_ma = sum(prices_list[-self.fast_period:]) / self.fast_period
        slow_ma = sum(prices_list) / self.slow_period

        fast_above = fast_ma > slow_ma

        if self.prev_fast_above is None:
            self.prev_fast_above = fast_above
            return "HOLD"

        signal = "HOLD"
        if fast_above and not self.prev_fast_above:
            signal = "BUY"
        elif not fast_above and self.prev_fast_above:
            signal = "SELL"

        self.prev_fast_above = fast_above
        return signal
`

  const SCALPING = `\
from collections import deque

class Strategy:
    def __init__(self):
        self.fast_period = 8
        self.slow_period = 21
        self.stop_loss_pct = 0.015
        self.take_profit_pct = 0.01
        self.prices = deque(maxlen=self.slow_period)
        self.entry_price = None
        self.in_position = False

    def _ema(self, data, period):
        if len(data) < period:
            return None
        prices = list(data)
        multiplier = 2 / (period + 1)
        ema = sum(prices[:period]) / period
        for p in prices[period:]:
            ema = (p - ema) * multiplier + ema
        return ema

    def on_tick(self, bar):
        price = bar["open"]
        self.prices.append(price)

        if self.in_position and self.entry_price is not None:
            if self.entry_price != 0:
                change = (price - self.entry_price) / self.entry_price
                if change <= -self.stop_loss_pct or change >= self.take_profit_pct:
                    self.in_position = False
                    self.entry_price = None
                    return "SELL"
            return "HOLD"

        fast_ema = self._ema(self.prices, self.fast_period)
        slow_ema = self._ema(self.prices, self.slow_period)

        if fast_ema is None or slow_ema is None:
            return "HOLD"

        if fast_ema > slow_ema:
            self.in_position = True
            self.entry_price = price
            return "BUY"

        return "HOLD"
`

  const CUSTOM = `\
from collections import deque

class Strategy:
    def __init__(self):
        # Initialize your state and parameters here
        self.prices = deque(maxlen=100)

    def on_tick(self, bar):
        # bar keys: "symbol", "open", "high", "low", "close", "volume", "timestamp"
        # Use bar["open"] for entry decisions (avoid lookahead bias)
        # Return "BUY", "SELL", or "HOLD"

        price = bar["open"]
        self.prices.append(price)

        if len(self.prices) < 20:
            return "HOLD"

        # Add your strategy logic here

        return "HOLD"
`
}
