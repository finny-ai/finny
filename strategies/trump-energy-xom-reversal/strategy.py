"""
XOM Bollinger Band Mean-Reversion Strategy (reconstruction — NEVER BACKTESTED)

Entry (all must hold):
  1. Uptrend: bar open > 50-bar SMA of closes
  2. Lower-band touch: bar open <= lower Bollinger band (20-bar, 2.0 std)
  3. Vol filter: std > 0 (avoids flat-line artifacts)

Exit (any triggers):
  1. Mid-band cross: open >= mid-band (20-bar SMA)
  2. Upper-band touch: open >= upper Bollinger band
  3. Stop-loss: open <= entry - 2.5 * ATR at entry
  4. Time stop: held >= 12 bars and still red

Risk: 2% per trade via ATR-based sizing, 50% max position.

Bands computed ONCE per bar — no redundant blocks.
Lookahead: decisions use bar["open"], indicators use prior closes.
"""

import math
from collections import deque


class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}

        self.bb_period = p.get("bb_period", 20)
        self.bb_std_mult = p.get("bb_std_mult", 2.0)
        self.trend_period = p.get("trend_period", 50)
        self.atr_period = p.get("atr_period", 14)
        self.stop_atr_mult = p.get("stop_atr_mult", 2.5)
        self.max_hold_bars = p.get("max_hold_bars", 12)
        self.risk_per_trade = p.get("risk_per_trade", 0.02)
        self.max_position_pct = p.get("max_position_pct", 0.50)

        maxlen = max(self.bb_period, self.trend_period, self.atr_period) + 5
        self.closes = deque(maxlen=maxlen)
        self.true_ranges = deque(maxlen=self.atr_period)

        self.entry_price = None
        self.entry_atr = None
        self.bars_held = 0

    def _atr(self):
        if len(self.true_ranges) < self.atr_period:
            return None
        return sum(self.true_ranges) / self.atr_period

    def _sma(self, period):
        if len(self.closes) < period:
            return None
        return sum(list(self.closes)[-period:]) / period

    def _bollinger(self):
        if len(self.closes) < self.bb_period:
            return None, None, None
        window = list(self.closes)[-self.bb_period:]
        mid = sum(window) / self.bb_period
        sq_dev = sum((x - mid) ** 2 for x in window)
        std = math.sqrt(sq_dev / (self.bb_period - 1))
        if std < 1e-10:
            return None, None, None
        lower = mid - self.bb_std_mult * std
        upper = mid + self.bb_std_mult * std
        return lower, mid, upper

    def _update_history(self, bar):
        if self.closes:
            prev_close = self.closes[-1]
            tr = max(
                bar["high"] - bar["low"],
                abs(bar["high"] - prev_close),
                abs(bar["low"] - prev_close),
            )
            self.true_ranges.append(tr)
        self.closes.append(bar["close"])

    def on_bar(self, symbol: str, bar: dict) -> None:
        open_p = bar["open"]
        position = self.broker.position(symbol)

        # EXIT
        if position > 0 and self.entry_price is not None:
            self.bars_held += 1

            lower, mid, upper = self._bollinger()
            atr = self._atr()
            stop_price = self.entry_price - self.stop_atr_mult * self.entry_atr
            time_stop = self.bars_held >= self.max_hold_bars and open_p < self.entry_price

            mid_cross = mid is not None and open_p >= mid
            upper_touch = upper is not None and open_p >= upper

            if open_p <= stop_price or time_stop or mid_cross or upper_touch:
                self.broker.sell(symbol, qty=position)
                self.entry_price = None
                self.entry_atr = None
                self.bars_held = 0
                self._update_history(bar)
                return

        # Compute indicators from history (prior bars only)
        lower, mid, upper = self._bollinger()
        sma_trend = self._sma(self.trend_period)
        atr = self._atr()

        # ENTRY
        if position == 0 and lower is not None and sma_trend is not None and atr is not None:
            in_uptrend = open_p > sma_trend
            at_lower_band = open_p <= lower

            if in_uptrend and at_lower_band:
                equity = self.broker.equity()
                stop_distance = atr * self.stop_atr_mult
                if stop_distance > 1e-6:
                    qty_by_risk = (equity * self.risk_per_trade) / stop_distance
                    qty_by_cap = (equity * self.max_position_pct) / open_p
                    qty = min(qty_by_risk, qty_by_cap)
                    qty = round(qty, 8)
                    if qty > 0 and qty * open_p >= 1.0:
                        self.broker.buy(symbol, qty=qty)
                        self.entry_price = open_p
                        self.entry_atr = atr
                        self.bars_held = 0

        self._update_history(bar)
