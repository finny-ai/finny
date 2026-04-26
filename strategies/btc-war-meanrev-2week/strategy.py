"""
BTC 4-Hour Mean-Reversion Strategy v2 (LOOSENED for 2-week alpha sprint)

Entry (all must hold):
  1. Trend: open > 50-bar SMA
  2. Mean-rev: z-score of open vs 20-bar SMA <= -1.0
  3. Vol: 0.5% <= ATR/price <= 10%
  4. Not-crash: z-score > -3.5

Exit (any triggers):
  1. Target: z-score >= 0.0
  2. Stop: open <= entry - 2.0 * ATR
  3. Time: held 8 bars and still red

Risk: 2.5% per trade, 60% position cap, kill-switch at -15%.
"""

import math
from collections import deque


class Strategy:
    def __init__(self, broker):
        self.broker = broker

        # Bounded history
        self.opens = deque(maxlen=80)
        self.highs = deque(maxlen=80)
        self.lows = deque(maxlen=80)
        self.closes = deque(maxlen=80)
        self.true_ranges = deque(maxlen=14)

        # Parameters
        self.zscore_lookback = 20
        self.trend_lookback = 50
        self.atr_period = 14
        self.zscore_entry = -1.0
        self.zscore_target = 0.0
        self.zscore_panic = -3.5
        self.stop_atr_mult = 2.0
        self.max_hold_bars = 8
        self.risk_per_trade = 0.025
        self.max_position_pct = 0.60
        self.min_atr_ratio = 0.005
        self.max_atr_ratio = 0.10
        self.kill_switch_threshold = 0.85

        # Trade state
        self.starting_capital = None
        self.entry_price = None
        self.stop_price = None
        self.entry_bar_index = None
        self.global_bar_index = 0
        self.trading_halted = False

    def _atr(self):
        if len(self.true_ranges) < self.atr_period:
            return None
        return sum(self.true_ranges) / len(self.true_ranges)

    def _sma(self, data, period):
        if len(data) < period:
            return None
        return sum(list(data)[-period:]) / period

    def _stddev(self, data, period, mean_val):
        if len(data) < period:
            return None
        window = list(data)[-period:]
        sq_dev_sum = sum((x - mean_val) ** 2 for x in window)
        return math.sqrt(sq_dev_sum / (period - 1))

    def _update_history(self, open_p, high_p, low_p, close_p):
        if len(self.closes) > 0:
            prev_close = self.closes[-1]
            tr = max(
                high_p - low_p,
                abs(high_p - prev_close),
                abs(low_p - prev_close),
            )
            self.true_ranges.append(tr)
        self.opens.append(open_p)
        self.highs.append(high_p)
        self.lows.append(low_p)
        self.closes.append(close_p)

    def _reset_trade_state(self):
        self.entry_price = None
        self.stop_price = None
        self.entry_bar_index = None

    def on_bar(self, symbol: str, bar: dict) -> None:
        open_p = bar["open"]
        high_p = bar["high"]
        low_p = bar["low"]
        close_p = bar["close"]

        self.global_bar_index += 1

        if self.starting_capital is None:
            self.starting_capital = self.broker.equity()
        live_capital = self.broker.equity()

        # Equity kill-switch at -15%
        if (
            not self.trading_halted
            and live_capital < self.starting_capital * self.kill_switch_threshold
        ):
            self.trading_halted = True
            position_open = self.broker.position(symbol)
            if position_open > 0:
                self.broker.sell(symbol, qty=position_open)
                self._reset_trade_state()
            self._update_history(open_p, high_p, low_p, close_p)
            return

        if self.trading_halted:
            self._update_history(open_p, high_p, low_p, close_p)
            return

        min_history = (
            max(self.zscore_lookback, self.trend_lookback, self.atr_period) + 2
        )
        if len(self.closes) < min_history:
            self._update_history(open_p, high_p, low_p, close_p)
            return

        atr = self._atr()
        sma_short = self._sma(self.closes, self.zscore_lookback)
        sma_trend = self._sma(self.closes, self.trend_lookback)
        if atr is None or sma_short is None or sma_trend is None:
            self._update_history(open_p, high_p, low_p, close_p)
            return

        stddev = self._stddev(self.closes, self.zscore_lookback, sma_short)
        if stddev is None or stddev <= 1e-10:
            self._update_history(open_p, high_p, low_p, close_p)
            return

        zscore = (open_p - sma_short) / stddev
        position = self.broker.position(symbol)

        # EXIT logic
        if (
            position > 0
            and self.entry_price is not None
            and self.entry_bar_index is not None
        ):
            bars_in_trade = self.global_bar_index - self.entry_bar_index
            stop_hit = open_p <= self.stop_price
            target_hit = zscore >= self.zscore_target
            time_stop_hit = (
                bars_in_trade >= self.max_hold_bars and open_p < self.entry_price
            )

            if stop_hit or target_hit or time_stop_hit:
                self.broker.sell(symbol, qty=position)
                self._reset_trade_state()
                self._update_history(open_p, high_p, low_p, close_p)
                return

        # ENTRY logic
        if position == 0:
            in_uptrend = open_p > sma_trend
            atr_ratio = atr / open_p if open_p > 1e-10 else 0.0
            vol_ok = self.min_atr_ratio <= atr_ratio <= self.max_atr_ratio
            oversold = zscore <= self.zscore_entry
            not_crash = zscore > self.zscore_panic

            if in_uptrend and vol_ok and oversold and not_crash:
                stop_distance = atr * self.stop_atr_mult
                if stop_distance > 1e-6 and open_p > 1e-10:
                    risk_amount = live_capital * self.risk_per_trade
                    qty_by_risk = risk_amount / stop_distance
                    qty_by_cap = (live_capital * self.max_position_pct) / open_p
                    qty_by_capital = live_capital / open_p
                    qty = min(qty_by_risk, qty_by_cap, qty_by_capital)
                    qty = round(qty, 8)

                    if qty * open_p >= 1.0:
                        self.broker.buy(symbol, qty=qty)
                        self.entry_price = open_p
                        self.stop_price = open_p - stop_distance
                        self.entry_bar_index = self.global_bar_index

        self._update_history(open_p, high_p, low_p, close_p)
