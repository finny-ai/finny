# Example Strategies

This file contains example trading strategies and usage patterns for Finny.

---

## 1. Simple Moving Average Crossover

A classic trend-following strategy.

```python
class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = []
        self.short_period = 10
        self.long_period = 20

    def on_tick(self, bar: dict) -> str:
        self.prices.append(bar['open'])

        if len(self.prices) < self.long_period:
            return 'HOLD'

        # Keep only what we need
        self.prices = self.prices[-self.long_period:]

        short_ma = sum(self.prices[-self.short_period:]) / self.short_period
        long_ma = sum(self.prices) / self.long_period

        if short_ma > long_ma and self.position == 0:
            self.position = 1
            return 'BUY'
        elif short_ma < long_ma and self.position == 1:
            self.position = 0
            return 'SELL'

        return 'HOLD'
```

**Usage**: `/build SMA crossover strategy with 10 and 20 period`

---

## 2. RSI Mean Reversion

Buy when oversold, sell when overbought.

```python
class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = []
        self.period = 14
        self.oversold = 30
        self.overbought = 70

    def calculate_rsi(self):
        if len(self.prices) < self.period + 1:
            return 50  # Neutral

        changes = [self.prices[i] - self.prices[i-1]
                   for i in range(1, len(self.prices))]

        gains = [c if c > 0 else 0 for c in changes[-self.period:]]
        losses = [-c if c < 0 else 0 for c in changes[-self.period:]]

        avg_gain = sum(gains) / self.period
        avg_loss = sum(losses) / self.period

        if avg_loss == 0:
            return 100

        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    def on_tick(self, bar: dict) -> str:
        self.prices.append(bar['open'])
        self.prices = self.prices[-(self.period + 10):]  # Keep buffer

        rsi = self.calculate_rsi()

        if rsi < self.oversold and self.position == 0:
            self.position = 1
            return 'BUY'
        elif rsi > self.overbought and self.position == 1:
            self.position = 0
            return 'SELL'

        return 'HOLD'
```

**Usage**: `/build RSI strategy, buy below 30, sell above 70`

---

## 3. Momentum Breakout

Buy on new highs with volume confirmation.

```python
class Strategy:
    def __init__(self):
        self.position = 0
        self.highs = []
        self.volumes = []
        self.lookback = 20

    def on_tick(self, bar: dict) -> str:
        self.highs.append(bar['high'])
        self.volumes.append(bar['volume'])

        if len(self.highs) < self.lookback:
            return 'HOLD'

        self.highs = self.highs[-self.lookback:]
        self.volumes = self.volumes[-self.lookback:]

        recent_high = max(self.highs[:-1])
        avg_volume = sum(self.volumes[:-1]) / (self.lookback - 1)

        # Breakout: new high with above-average volume
        if (bar['open'] > recent_high and
            bar['volume'] > avg_volume * 1.5 and
            self.position == 0):
            self.position = 1
            return 'BUY'

        # Exit: price drops below 20-period low
        if self.position == 1:
            recent_low = min(self.highs)
            if bar['open'] < recent_low:
                self.position = 0
                return 'SELL'

        return 'HOLD'
```

**Usage**: `/build breakout strategy on new highs with volume`

---

## 4. Simple Stop-Loss Strategy

Basic strategy with trailing stop.

```python
class Strategy:
    def __init__(self):
        self.position = 0
        self.entry_price = 0
        self.highest_since_entry = 0
        self.stop_loss_pct = 0.05  # 5%

    def on_tick(self, bar: dict) -> str:
        price = bar['open']

        if self.position == 1:
            self.highest_since_entry = max(self.highest_since_entry, price)

            # Trailing stop: sell if price drops 5% from peak
            stop_price = self.highest_since_entry * (1 - self.stop_loss_pct)
            if price < stop_price:
                self.position = 0
                return 'SELL'

        # Simple entry: buy every 10 ticks if not in position
        # (Replace with real logic)
        if self.position == 0:
            self.position = 1
            self.entry_price = price
            self.highest_since_entry = price
            return 'BUY'

        return 'HOLD'
```

---

## Usage Patterns

### Research First

```
> /research BTC
# Shows recent price data, trends, volatility

> /build based on research, RSI strategy for BTC
# AI uses research context to build strategy
```

### Iterate on Strategy

```
> /build simple momentum strategy
# AI generates initial strategy

> make it use 14-period RSI instead
# AI modifies the strategy

> add a 3% stop loss
# AI adds stop loss logic

> /deploy
# Deploy final version
```

### Debug and Fix

```
> /deploy
# Error: lookahead bias detected on line 15

> fix the lookahead bias
# AI fixes bar['close'] usage

> /deploy
# Success!
```

---

## Anti-Patterns (Don't Do This)

### Lookahead Bias

```python
# BAD - using close price for decisions
def on_tick(self, bar):
    if bar['close'] > bar['open']:  # Can't know close yet!
        return 'BUY'
```

### No Position Tracking

```python
# BAD - will keep buying
def on_tick(self, bar):
    if bar['open'] > 100:
        return 'BUY'  # Might already own it!
```

### Forbidden Imports

```python
# BAD - security risk
import os
import subprocess
from socket import *
```

---

## Tips

1. **Always track position** - Don't buy if already long
2. **Use `bar['open']`** - Never `bar['close']` for entry decisions
3. **Keep state minimal** - Strategy resets on restart
4. **Test with /research first** - Understand the data before building
5. **Start simple** - Add complexity gradually
