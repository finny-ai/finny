# Strategy: jaimins_1st_algo
# Symbol: BTC
# Type: custom
# Created: 2026-02-06T06:23:14.452Z
#
# To deploy: finny deploy jaimins_1st_algo
# To validate: finny validate jaimins_1st_algo

"""
Custom Strategy Template
------------------------
A blank template for implementing your own trading logic.
Customize the on_tick method with your strategy rules.

Guidelines:
- Use bar["open"] for entry decisions to avoid lookahead bias
- Return "BUY", "SELL", or "HOLD" from on_tick
- Use bounded data structures (deque with maxlen)
- Handle edge cases (insufficient data, division by zero)

Allowed imports:
- math, statistics, collections, dataclasses, typing
- decimal, random, itertools, functools
"""

from collections import deque


def calculate_sma(prices: deque, period: int) -> float:
    if len(prices) < period:
        return 0.0
    window = list(prices)[-period:]
    return sum(window) / period


def calculate_rsi(prices: deque, period: int = 14) -> float:
    if len(prices) < period + 1:
        return 0.0

    window = list(prices)[-(period + 1) :]
    gains = 0.0
    losses = 0.0

    for i in range(1, len(window)):
        change = window[i] - window[i - 1]
        if change > 0:
            gains += change
        elif change < 0:
            losses += abs(change)

    average_gain = gains / period
    average_loss = losses / period

    if average_loss == 0:
        return 100.0
    if average_gain == 0:
        return 0.0

    rs = average_gain / average_loss
    return 100.0 - (100.0 / (1.0 + rs))


class Strategy:
    def __init__(self):
        # Position tracking (0 = flat, 1 = long)
        self.position = 0

        # Price history with bounded memory
        self.prices = deque(maxlen=200)

        # Indicator settings (round, standard periods)
        self.rsi_period = 14
        self.sma_fast_period = 50
        self.sma_slow_period = 200

        # Risk management
        self.trailing_stop_pct = 0.02
        self.hard_stop_pct = 0.05
        self.max_drawdown_pct = 0.08
        self.consecutive_loss_limit = 3
        self.cooldown_bars = 10

        # Trade tracking
        self.entry_price = 0.0
        self.peak_price = 0.0
        self.prev_rsi = None
        self.consecutive_losses = 0
        self.cooldown_remaining = 0

        # Equity tracking (normalized)
        self.equity = 1.0
        self.equity_at_entry = 1.0
        self.peak_equity = 1.0
        self.trading_halted = False

        # Add your custom state variables here
        # self.my_indicator = 0.0
        # self.entry_price = 0.0

    def on_tick(self, bar: dict) -> str:
        """
        Called on each new price bar.

        Args:
            bar: Dictionary with keys:
                - symbol: Trading symbol (e.g., "BTC")
                - open: Opening price (use this for decisions)
                - high: High price
                - low: Low price
                - close: Closing price
                - volume: Trading volume
                - timestamp: Unix timestamp

        Returns:
            "BUY" - Enter long position
            "SELL" - Exit position
            "HOLD" - Do nothing
        """
        price = bar["open"]  # Use open price for decisions
        self.prices.append(price)

        # Update equity and drawdown tracking
        if self.position == 1 and self.entry_price > 0:
            self.equity = self.equity_at_entry * (price / self.entry_price)
        if self.equity > self.peak_equity:
            self.peak_equity = self.equity
        if self.peak_equity > 0:
            drawdown = (self.peak_equity - self.equity) / self.peak_equity
            if drawdown >= self.max_drawdown_pct:
                self.trading_halted = True

        if self.cooldown_remaining > 0:
            self.cooldown_remaining -= 1

        # Wait for enough data
        if len(self.prices) < self.sma_slow_period:
            return "HOLD"

        sma_fast = calculate_sma(self.prices, self.sma_fast_period)
        sma_slow = calculate_sma(self.prices, self.sma_slow_period)
        rsi = calculate_rsi(self.prices, self.rsi_period)

        rsi_cross_up_35 = False
        rsi_cross_up_70 = False
        if self.prev_rsi is not None:
            rsi_cross_up_35 = self.prev_rsi < 35 and rsi >= 35
            rsi_cross_up_70 = self.prev_rsi <= 70 and rsi > 70

        self.prev_rsi = rsi

        # Exit logic (applies even during cooldown/halt)
        if self.position == 1:
            if price > self.peak_price:
                self.peak_price = price

            trailing_stop_price = self.peak_price * (1 - self.trailing_stop_pct)
            hard_stop_price = self.entry_price * (1 - self.hard_stop_pct)

            if price <= trailing_stop_price or price <= hard_stop_price:
                is_loss = price <= self.entry_price
                if is_loss:
                    self.consecutive_losses += 1
                else:
                    self.consecutive_losses = 0
                if self.consecutive_losses >= self.consecutive_loss_limit:
                    self.cooldown_remaining = self.cooldown_bars
                self.position = 0
                self.entry_price = 0.0
                self.peak_price = 0.0
                return "SELL"

            if rsi_cross_up_70 or price < sma_fast:
                is_loss = price <= self.entry_price
                if is_loss:
                    self.consecutive_losses += 1
                else:
                    self.consecutive_losses = 0
                if self.consecutive_losses >= self.consecutive_loss_limit:
                    self.cooldown_remaining = self.cooldown_bars
                self.position = 0
                self.entry_price = 0.0
                self.peak_price = 0.0
                return "SELL"

        # Entry logic (cooldown + drawdown protection)
        if self.position == 0:
            if self.trading_halted:
                return "HOLD"
            if self.cooldown_remaining > 0:
                return "HOLD"

            uptrend_confirmed = price > sma_fast and sma_fast > sma_slow
            if uptrend_confirmed and rsi_cross_up_35:
                self.position = 1
                self.entry_price = price
                self.peak_price = price
                self.equity_at_entry = self.equity
                return "BUY"

        return "HOLD"
