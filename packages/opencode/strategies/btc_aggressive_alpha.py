# Strategy: btc_aggressive_alpha
# Symbol: BTC
# Type: momentum
# Created: 2026-02-04T14:36:42.811Z
#
# To deploy: finny deploy btc_aggressive_alpha
# To validate: finny validate btc_aggressive_alpha

"""
Momentum Strategy
-----------------
Buys when RSI indicates oversold conditions, sells when overbought.
Uses RSI (Relative Strength Index) to identify momentum shifts.

Parameters:
- rsi_period: Number of bars for RSI calculation (default: 14)
- rsi_oversold: RSI threshold to buy (default: 30)
- rsi_overbought: RSI threshold to sell (default: 70)
"""

import math
import statistics
from collections import deque


class Strategy:
    def __init__(self):
        self.position = 0
        self.maxlen = 50
        self.prices = deque(maxlen=self.maxlen)

        # Strategy Parameters
        self.rsi_period = 14
        self.bb_period = 20
        self.bb_std_dev = 2.0

        # Aggressive Settings
        self.rsi_buy_threshold = 30  # Buy deep dips
        self.rsi_sell_threshold = 75  # Sell into euphoria (as requested)
        self.stop_loss_pct = 0.08  # 8% max drawdown tolerance
        self.take_profit_pct = 0.15  # 15% initial target

        # State tracking
        self.entry_price = 0.0
        self.gains = deque(maxlen=self.rsi_period)
        self.losses = deque(maxlen=self.rsi_period)
        self.last_price = None

    def calculate_rsi(self) -> float:
        """Calculate RSI from recent price changes."""
        if len(self.gains) < self.rsi_period:
            return 50.0

        avg_gain = sum(self.gains) / len(self.gains)
        avg_loss = sum(self.losses) / len(self.losses)

        if avg_loss == 0:
            return 100.0

        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    def calculate_bollinger_bands(self):
        """Calculate Upper and Lower Bollinger Bands."""
        if len(self.prices) < self.bb_period:
            return None, None

        # Get the last N prices for BB calculation
        recent_prices = list(self.prices)[-self.bb_period :]
        sma = statistics.mean(recent_prices)
        std_dev = statistics.stdev(recent_prices)

        upper_band = sma + (std_dev * self.bb_std_dev)
        lower_band = sma - (std_dev * self.bb_std_dev)

        return upper_band, lower_band

    def on_tick(self, bar: dict) -> str:
        current_price = bar["open"]
        self.prices.append(current_price)

        # Update RSI Data
        if self.last_price is not None:
            change = current_price - self.last_price
            if change > 0:
                self.gains.append(change)
                self.losses.append(0)
            else:
                self.gains.append(0)
                self.losses.append(abs(change))
        self.last_price = current_price

        # Wait for sufficient data
        if len(self.prices) < self.bb_period:
            return "HOLD"

        # Calculate Indicators
        rsi = self.calculate_rsi()
        upper_bb, lower_bb = self.calculate_bollinger_bands()

        # --- EXIT LOGIC ---
        if self.position == 1:
            # 1. Stop Loss Protection
            if current_price < self.entry_price * (1 - self.stop_loss_pct):
                self.position = 0
                return "SELL"

            # 2. Take Profit: RSI Euphoria OR Price above Upper BB
            if rsi > self.rsi_sell_threshold:
                self.position = 0
                return "SELL"

            # 3. Dynamic Take Profit: Strong breakout extension
            if upper_bb and current_price > upper_bb * 1.05:  # 5% above upper band
                self.position = 0
                return "SELL"

        # --- ENTRY LOGIC ---
        elif self.position == 0:
            # Setup 1: Deep Value (RSI Oversold + Price near Lower Band)
            if (
                rsi < self.rsi_buy_threshold
                and lower_bb
                and current_price <= lower_bb * 1.02
            ):
                self.position = 1
                self.entry_price = current_price
                return "BUY"

            # Setup 2: Volatility Squeeze Breakout (Aggressive)
            # If price breaks Upper BB with momentum (RSI > 50 but not overbought)
            if upper_bb and current_price > upper_bb and 50 < rsi < 70:
                self.position = 1
                self.entry_price = current_price
                return "BUY"

        return "HOLD"
