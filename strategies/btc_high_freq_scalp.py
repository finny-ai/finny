# Strategy: btc_high_freq_scalp
# Symbol: BTC
# Type: scalping
# Created: 2026-02-03T14:38:22.708Z
#
# To deploy: finny deploy btc_high_freq_scalp
# To validate: finny validate btc_high_freq_scalp

"""
Mean-Reversion Scalping Strategy
-----------------
High-frequency strategy targeting small, quick profits through mean-reversion.
Uses RSI and Bollinger Bands to identify overbought/oversold conditions.

Parameters:
- rsi_period: Period for RSI calculation (default: 14)
- bb_period: Period for Bollinger Bands (default: 20)
- bb_std: Standard deviation multiplier for Bollinger Bands (default: 2.0)
- take_profit_pct: Quick profit target (default: 0.5%)
- stop_loss_pct: Tight stop loss (default: 0.5%)
"""

from collections import deque
import statistics


class Strategy:
    def __init__(self):
        self.position = 0
        self.closes = deque(maxlen=50)

        # Scalping Parameters
        self.rsi_period = 14
        self.bb_period = 20
        self.bb_std = 2.0
        self.take_profit_pct = 0.005  # 0.5% profit target
        self.stop_loss_pct = 0.005    # 0.5% stop loss

        # Trade State
        self.entry_price = 0.0
        self.bars_in_trade = 0
        self.max_bars = 10  # Exit after N bars regardless

    def calculate_rsi(self) -> float:
        if len(self.closes) < self.rsi_period + 1:
            return 50.0  # neutral
        # calculate gains and losses
        gains = []
        losses = []
        closes_list = list(self.closes)[-self.rsi_period-1:]
        for i in range(1, len(closes_list)):
            change = closes_list[i] - closes_list[i-1]
            if change > 0:
                gains.append(change)
                losses.append(0)
            else:
                gains.append(0)
                losses.append(-change)
        avg_gain = sum(gains) / len(gains) if gains else 0
        avg_loss = sum(losses) / len(losses) if losses else 0
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        return rsi

    def calculate_bb(self):
        if len(self.closes) < self.bb_period:
            return 0, 0, 0  # sma, upper, lower
        recent = list(self.closes)[-self.bb_period:]
        sma = statistics.mean(recent)
        std = statistics.stdev(recent)
        upper = sma + self.bb_std * std
        lower = sma - self.bb_std * std
        return sma, upper, lower

    def on_tick(self, bar: dict) -> str:
        close = bar["close"]
        self.closes.append(close)

        # Need enough data
        if len(self.closes) < self.bb_period:
            return "HOLD"

        rsi = self.calculate_rsi()
        sma, upper_bb, lower_bb = self.calculate_bb()

        # Position management
        if self.position == 1:
            self.bars_in_trade += 1
            pnl_pct = (close - self.entry_price) / self.entry_price

            # Take profit
            if pnl_pct >= self.take_profit_pct:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            # Stop loss
            if pnl_pct <= -self.stop_loss_pct:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            # RSI overbought or price above upper BB
            if rsi > 70 or close > upper_bb:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            # Time-based exit
            if self.bars_in_trade >= self.max_bars:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            return "HOLD"

        # Entry logic: Buy when RSI < 30 and price < lower BB
        if rsi < 30 and close < lower_bb:
            self.position = 1
            self.entry_price = close
            self.bars_in_trade = 0
            return "BUY"

        return "HOLD"
