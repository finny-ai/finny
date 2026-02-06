"""
PLTR Earnings Day Trading Strategy - Enhanced Version
======================================================

Target: February 2, 2026 Earnings (After Market Close)
Trading Day: February 3, 2026 (when the gap occurs)

Research Summary:
-----------------
- PLTR reports After Market Close (AMC) on Feb 2, 2026
- Current Price: ~$165.70 | 52-Week Range: $66.12 - $207.52
- Beta: 1.54 (high volatility) | P/E: 385x (extreme valuation = high sensitivity)
- Historical earnings moves: 10-15% typical, up to 20-30% on major surprises
- Recent trend: Strong beats last 2 quarters (+50-62% EPS surprise)
- Support: $150-155 | Resistance: $180-190

Strategy Design:
----------------
Since PLTR reports AMC, the gap occurs at NEXT DAY's open (Feb 3).
This strategy handles 4 scenarios based on gap magnitude:

1. EXTREME GAP DOWN (>15%): Mean-reversion fade after stabilization
2. MODERATE GAP DOWN (8-15%): Wait for reversal confirmation
3. GAP UP (5-15%): Momentum continuation on pullback
4. EXTREME GAP UP (>15%): Avoid chasing, wait for pullback

Risk Management:
- Volatility-adjusted stops (1.5-2x wider for earnings)
- Maximum 1 trade per session
- Trailing stops activated at 6% profit
- Hard stop at 10% loss
"""

from collections import deque
import math


class Strategy:
    def __init__(self):
        self.position = 0  # 0 = flat, 1 = long

        # Price history
        self.prices = deque(maxlen=100)
        self.volumes = deque(maxlen=50)
        self.highs = deque(maxlen=50)
        self.lows = deque(maxlen=50)
        self.closes = deque(maxlen=50)

        # Session tracking
        self.session_open = None
        self.session_high = None
        self.session_low = None
        self.prev_session_close = None
        self.bars_in_session = 0
        self.last_timestamp = None

        # Trade management
        self.entry_price = None
        self.entry_bar = 0
        self.stop_loss = None
        self.take_profit = None
        self.trailing_stop = None
        self.traded_today = False

        # Volatility tracking (ATR)
        self.atr_period = 14
        self.true_ranges = deque(maxlen=self.atr_period)

        # Earnings-specific parameters
        self.earnings_vol_multiplier = 1.75  # Wider stops for earnings

        # Gap thresholds (calibrated for PLTR's typical moves)
        self.extreme_gap_down = -0.15  # -15%
        self.moderate_gap_down = -0.08  # -8%
        self.small_gap = 0.05  # 5%
        self.moderate_gap_up = 0.15  # 15%

        # Risk parameters
        self.max_loss_percent = 0.10  # 10% max loss
        self.trailing_activation = 0.06  # Activate trailing at 6% profit
        self.trailing_distance = 0.03  # 3% trailing distance

    def calculate_atr(self):
        """Calculate Average True Range"""
        if len(self.true_ranges) < self.atr_period:
            if len(self.true_ranges) > 0:
                return sum(self.true_ranges) / len(self.true_ranges)
            return None
        return sum(self.true_ranges) / self.atr_period

    def calculate_gap(self, current_open):
        """Calculate gap percentage from previous session close"""
        if self.prev_session_close is None or self.prev_session_close == 0:
            return 0
        return (current_open - self.prev_session_close) / self.prev_session_close

    def calculate_momentum(self, lookback=10):
        """Calculate price momentum"""
        if len(self.prices) < lookback + 1:
            return 0
        prices_list = list(self.prices)
        if prices_list[-lookback] == 0:
            return 0
        return (prices_list[-1] - prices_list[-lookback]) / prices_list[-lookback]

    def calculate_volume_ratio(self, lookback=10):
        """Compare current volume to recent average"""
        if len(self.volumes) < lookback:
            return 1.0
        volumes_list = list(self.volumes)
        avg_vol = (
            sum(volumes_list[-lookback:-1]) / (lookback - 1)
            if lookback > 1
            else volumes_list[-1]
        )
        if avg_vol == 0:
            return 1.0
        return volumes_list[-1] / avg_vol

    def is_new_session(self, bar):
        """Detect new trading session based on timestamp gap"""
        if self.last_timestamp is None:
            return True

        # Assume new session if >4 hours gap (overnight)
        time_gap_ms = bar["timestamp"] - self.last_timestamp
        time_gap_hours = time_gap_ms / (1000 * 60 * 60)

        return time_gap_hours > 4

    def reset_session(self, bar):
        """Reset session tracking for new day"""
        self.prev_session_close = self.closes[-1] if len(self.closes) > 0 else None
        self.session_open = bar["open"]
        self.session_high = bar["high"]
        self.session_low = bar["low"]
        self.bars_in_session = 1
        self.traded_today = False

    def update_session(self, bar):
        """Update session high/low"""
        if self.session_high is not None:
            self.session_high = max(self.session_high, bar["high"])
        else:
            self.session_high = bar["high"]

        if self.session_low is not None:
            self.session_low = min(self.session_low, bar["low"])
        else:
            self.session_low = bar["low"]

        self.bars_in_session += 1

    def update_true_range(self, bar):
        """Calculate and store true range for ATR"""
        if len(self.closes) < 1:
            tr = bar["high"] - bar["low"]
        else:
            prev_close = self.closes[-1]
            tr = max(
                bar["high"] - bar["low"],
                abs(bar["high"] - prev_close),
                abs(bar["low"] - prev_close),
            )
        self.true_ranges.append(tr)

    def check_exit_conditions(self, current_price, atr):
        """Check all exit conditions for open position"""
        if self.position != 1:
            return None

        # 1. Hard stop loss
        if self.stop_loss and current_price <= self.stop_loss:
            return "STOP_LOSS"

        # 2. Take profit
        if self.take_profit and current_price >= self.take_profit:
            return "TAKE_PROFIT"

        # 3. Trailing stop
        if self.trailing_stop and current_price <= self.trailing_stop:
            return "TRAILING_STOP"

        # 4. Maximum loss check (backup)
        if self.entry_price:
            loss_percent = (self.entry_price - current_price) / self.entry_price
            if loss_percent >= self.max_loss_percent:
                return "MAX_LOSS"

        # 5. Time-based exit: if held too long without profit, exit
        if self.entry_bar > 0 and self.bars_in_session - self.entry_bar > 20:
            if self.entry_price and current_price < self.entry_price * 1.02:
                return "TIME_EXIT"

        return None

    def update_trailing_stop(self, current_price):
        """Update trailing stop if in profit"""
        if self.position != 1 or self.entry_price is None:
            return

        profit_percent = (current_price - self.entry_price) / self.entry_price

        # Activate trailing stop at threshold
        if profit_percent >= self.trailing_activation:
            new_trailing = current_price * (1 - self.trailing_distance)

            if self.trailing_stop is None:
                self.trailing_stop = new_trailing
            else:
                # Only move trailing stop up, never down
                self.trailing_stop = max(self.trailing_stop, new_trailing)

    def close_position(self):
        """Reset position and trade tracking"""
        self.position = 0
        self.entry_price = None
        self.entry_bar = 0
        self.stop_loss = None
        self.take_profit = None
        self.trailing_stop = None

    def on_tick(self, bar: dict) -> str:
        """
        Main strategy logic for PLTR earnings day.

        Handles 4 gap scenarios with appropriate entry/exit logic.
        Uses volatility-adjusted stops and trailing stops for risk management.
        """
        current_price = bar["open"]  # Use open to avoid lookahead bias

        # Update true range before adding new data
        self.update_true_range(bar)

        # Update price history
        self.prices.append(current_price)
        self.volumes.append(bar["volume"])
        self.highs.append(bar["high"])
        self.lows.append(bar["low"])
        self.closes.append(bar["close"])

        # Check for new session
        if self.is_new_session(bar):
            self.reset_session(bar)
            gap_percent = self.calculate_gap(current_price)
        else:
            self.update_session(bar)
            gap_percent = 0  # Only calculate gap on first bar of session

        self.last_timestamp = bar["timestamp"]

        # Need minimum history for calculations
        if len(self.prices) < 15:
            return "HOLD"

        atr = self.calculate_atr()
        momentum = self.calculate_momentum(10)
        volume_ratio = self.calculate_volume_ratio(10)

        # ============================================
        # POSITION MANAGEMENT (if we have a position)
        # ============================================
        if self.position == 1:
            # Update trailing stop
            self.update_trailing_stop(current_price)

            # Check exit conditions
            exit_reason = self.check_exit_conditions(current_price, atr)
            if exit_reason:
                self.close_position()
                return "SELL"

            # Momentum reversal exit
            if momentum < -0.04:  # Strong negative momentum
                self.close_position()
                return "SELL"

            return "HOLD"

        # ============================================
        # ENTRY LOGIC (only if flat and haven't traded today)
        # ============================================
        if self.position == 0 and not self.traded_today and atr:
            # Calculate earnings-adjusted ATR for stops
            earnings_atr = atr * self.earnings_vol_multiplier

            # -----------------------------------------
            # SCENARIO 1: EXTREME GAP DOWN (< -15%)
            # Strategy: Mean-reversion fade after stabilization
            # -----------------------------------------
            if gap_percent < self.extreme_gap_down:
                # Wait for stabilization (at least 5 bars)
                if self.bars_in_session >= 5:
                    # Check if price is holding above session low
                    if self.session_low and current_price > self.session_low * 1.005:
                        # Look for momentum turning positive
                        short_momentum = self.calculate_momentum(5)
                        if short_momentum > 0.01:  # Slight positive momentum
                            self.position = 1
                            self.entry_price = current_price
                            self.entry_bar = self.bars_in_session

                            # Wide stop below session low
                            self.stop_loss = self.session_low * 0.97

                            # Target: 40% gap fill
                            if self.prev_session_close and self.session_open:
                                gap_size = abs(
                                    self.prev_session_close - self.session_open
                                )
                                self.take_profit = current_price + (gap_size * 0.4)
                            else:
                                self.take_profit = current_price * 1.08

                            self.traded_today = True
                            return "BUY"

            # -----------------------------------------
            # SCENARIO 2: MODERATE GAP DOWN (-8% to -15%)
            # Strategy: Wait for reversal confirmation
            # -----------------------------------------
            elif gap_percent < self.moderate_gap_down:
                # Wait longer for confirmation (8+ bars)
                if self.bars_in_session >= 8:
                    # Need positive momentum and volume
                    if momentum > 0.02 and volume_ratio > 1.2:
                        # Price should be recovering from lows
                        if self.session_low and current_price > self.session_low * 1.02:
                            self.position = 1
                            self.entry_price = current_price
                            self.entry_bar = self.bars_in_session

                            self.stop_loss = current_price - (earnings_atr * 2.5)
                            self.take_profit = current_price * 1.06  # 6% target

                            self.traded_today = True
                            return "BUY"

            # -----------------------------------------
            # SCENARIO 3: GAP UP (5% to 15%)
            # Strategy: Momentum continuation on pullback
            # -----------------------------------------
            elif gap_percent > self.small_gap and gap_percent < self.moderate_gap_up:
                # Wait for pullback (5+ bars)
                if self.bars_in_session >= 5:
                    # Check for pullback from high
                    if self.session_high:
                        pullback = (
                            self.session_high - current_price
                        ) / self.session_high

                        # 2-5% pullback is ideal entry
                        if 0.02 < pullback < 0.05:
                            # Volume should still be elevated
                            if volume_ratio > 1.0:
                                # Momentum should still be positive
                                if momentum > 0:
                                    self.position = 1
                                    self.entry_price = current_price
                                    self.entry_bar = self.bars_in_session

                                    # Stop below session low
                                    self.stop_loss = (
                                        self.session_low * 0.98
                                        if self.session_low
                                        else current_price * 0.92
                                    )
                                    self.take_profit = current_price * 1.08  # 8% target

                                    self.traded_today = True
                                    return "BUY"

            # -----------------------------------------
            # SCENARIO 4: EXTREME GAP UP (> 15%)
            # Strategy: Avoid chasing, wait for deep pullback
            # -----------------------------------------
            elif gap_percent > self.moderate_gap_up:
                # Need significant pullback before entry (10+ bars)
                if self.bars_in_session >= 10:
                    if self.session_high:
                        pullback = (
                            self.session_high - current_price
                        ) / self.session_high

                        # Need 5-10% pullback for extreme gaps
                        if 0.05 < pullback < 0.10:
                            # Must have strong volume
                            if volume_ratio > 1.5:
                                self.position = 1
                                self.entry_price = current_price
                                self.entry_bar = self.bars_in_session

                                self.stop_loss = current_price - (earnings_atr * 3)
                                self.take_profit = current_price * 1.10  # 10% target

                                self.traded_today = True
                                return "BUY"

            # -----------------------------------------
            # SCENARIO 5: SMALL/NO GAP (< 5%)
            # Strategy: Standard momentum breakout
            # -----------------------------------------
            else:
                # Standard momentum entry
                if self.bars_in_session >= 3:
                    if momentum > 0.03 and volume_ratio > 1.3:
                        # Price near session highs
                        if (
                            self.session_high
                            and current_price > self.session_high * 0.995
                        ):
                            self.position = 1
                            self.entry_price = current_price
                            self.entry_bar = self.bars_in_session

                            self.stop_loss = current_price - (atr * 2)
                            self.take_profit = current_price + (atr * 4)

                            self.traded_today = True
                            return "BUY"

        return "HOLD"
