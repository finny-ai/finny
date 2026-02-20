# Strategy: btc_momentum
# Symbol: BTC
# Type: momentum
# Created: 2026-02-19T18:22:23.904Z

"""
BTC Momentum Breakout Strategy
------------------------------
A day trading strategy using MACD, RSI, and Bollinger Bands.

Logic:
- Entry: MACD is bullish (MACD > Signal), RSI is between 50-70 (moderate momentum),
  and Price is above the 20-period SMA (Middle Bollinger Band).
- Exit: Price touches Upper Bollinger Band, RSI hits 75, or 1.5% Stop Loss triggered.
"""

from collections import deque
import math


class Strategy:
    def __init__(self):
        self.position = 0
        self.entry_price = 0
        self.prices = deque(maxlen=100)

        # Indicator Parameters
        self.rsi_period = 14
        self.bb_period = 20
        self.bb_std = 2.0

        # MACD Parameters
        self.ema_fast_p = 12
        self.ema_slow_p = 26
        self.signal_p = 9

        self.ema_fast = None
        self.ema_slow = None
        self.macd_signal = None

        # RSI tracking
        self.gains = deque(maxlen=self.rsi_period)
        self.losses = deque(maxlen=self.rsi_period)
        self.last_price = None

    def update_emas(self, price: float):
        # Initialize or update EMAs
        if self.ema_fast is None or self.ema_slow is None:
            self.ema_fast = float(price)
            self.ema_slow = float(price)
        else:
            alpha_f = 2 / (self.ema_fast_p + 1)
            alpha_s = 2 / (self.ema_slow_p + 1)
            # Ensure they are treated as floats for the type checker
            self.ema_fast = float((price - self.ema_fast) * alpha_f + self.ema_fast)
            self.ema_slow = float((price - self.ema_slow) * alpha_s + self.ema_slow)

    def calculate_macd(self) -> tuple:
        if self.ema_fast is None or self.ema_slow is None:
            return 0.0, 0.0

        macd_line = self.ema_fast - self.ema_slow

        if self.macd_signal is None:
            self.macd_signal = macd_line
        else:
            alpha_sig = 2 / (self.signal_p + 1)
            self.macd_signal = (
                macd_line - self.macd_signal
            ) * alpha_sig + self.macd_signal

        return macd_line, self.macd_signal

    def calculate_rsi(self) -> float:
        if len(self.gains) < self.rsi_period:
            return 50.0
        avg_gain = sum(self.gains) / len(self.gains)
        avg_loss = sum(self.losses) / len(self.losses)
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    def calculate_bb(self) -> tuple:
        if len(self.prices) < self.bb_period:
            return 0.0, 0.0, 0.0

        recent_prices = list(self.prices)[-self.bb_period :]
        sma = sum(recent_prices) / self.bb_period
        variance = sum((p - sma) ** 2 for p in recent_prices) / self.bb_period
        std = math.sqrt(variance)

        upper = sma + (self.bb_std * std)
        lower = sma - (self.bb_std * std)
        return upper, sma, lower

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]
        self.prices.append(price)

        # Update Indicators
        self.update_emas(price)
        macd_line, macd_sig = self.calculate_macd()

        if self.last_price is not None:
            change = price - self.last_price
            self.gains.append(max(0, change))
            self.losses.append(max(0, -change))
        self.last_price = price

        # Check data sufficiency
        if len(self.prices) < 30:  # Need enough for BB and MACD convergence
            return "HOLD"

        rsi = self.calculate_rsi()
        bb_upper, bb_mid, bb_lower = self.calculate_bb()

        # Stop Loss Check
        if self.position == 1:
            if price <= self.entry_price * 0.985:
                self.position = 0
                return "SELL"

        # Entry Logic
        if self.position == 0:
            if macd_line > macd_sig and 50 < rsi < 70 and price > bb_mid:
                self.position = 1
                self.entry_price = price
                return "BUY"

        # Exit Logic
        elif self.position == 1:
            if price >= bb_upper or rsi >= 75:
                self.position = 0
                return "SELL"

        return "HOLD"
