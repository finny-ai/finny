# Strategy: btc_high_freq_scalp
# Symbol: BTC
# Type: scalping
# Created: 2026-02-03T14:38:22.708Z
#
# To deploy: finny deploy btc_high_freq_scalp
# To validate: finny validate btc_high_freq_scalp

"""
Scalping Strategy
-----------------
High-frequency strategy targeting small, quick profits.
Uses price momentum and volatility to find short-term opportunities.

Parameters:
- momentum_period: Bars for momentum calculation (default: 5)
- take_profit_pct: Quick profit target (default: 0.5%)
- stop_loss_pct: Tight stop loss (default: 0.3%)
"""

from collections import deque
import statistics


class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = deque(maxlen=20)

        # Scalping Parameters
        self.momentum_period = 5
        self.take_profit_pct = 0.005  # 0.5% profit target
        self.stop_loss_pct = 0.003    # 0.3% stop loss

        # Trade State
        self.entry_price = 0.0
        self.bars_in_trade = 0
        self.max_bars = 10  # Exit after N bars regardless

    def calculate_momentum(self) -> float:
        """Calculate price momentum (rate of change)."""
        if len(self.prices) < self.momentum_period:
            return 0.0

        recent = list(self.prices)[-self.momentum_period:]
        if recent[0] == 0:
            return 0.0

        return (recent[-1] - recent[0]) / recent[0]

    def calculate_volatility(self) -> float:
        """Calculate recent price volatility."""
        if len(self.prices) < self.momentum_period:
            return 0.0

        recent = list(self.prices)[-self.momentum_period:]
        if len(recent) < 2:
            return 0.0

        return statistics.stdev(recent) / statistics.mean(recent)

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]
        self.prices.append(price)

        # Need enough data
        if len(self.prices) < self.momentum_period:
            return "HOLD"

        # Position management
        if self.position == 1:
            self.bars_in_trade += 1
            pnl_pct = (price - self.entry_price) / self.entry_price

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

            # Time-based exit
            if self.bars_in_trade >= self.max_bars:
                self.position = 0
                self.bars_in_trade = 0
                return "SELL"

            return "HOLD"

        # Entry logic: Look for positive momentum in low volatility
        momentum = self.calculate_momentum()
        volatility = self.calculate_volatility()

        # Buy when momentum is positive and volatility is reasonable
        if momentum > 0.002 and volatility < 0.02:  # 0.2% momentum, <2% volatility
            self.position = 1
            self.entry_price = price
            self.bars_in_trade = 0
            return "BUY"

        return "HOLD"
