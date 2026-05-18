"""
XOM RSI + SMA Momentum Strategy (reconstruction — NEVER BACKTESTED)

Entry (all must hold):
  1. Uptrend: bar open > 50-bar SMA of closes
  2. Oversold: RSI(14) of closes < 30
  3. Vol filter: 0.5% <= ATR(14)/price <= 10%

Exit (any triggers):
  1. Take-profit: open >= entry * 1.06
  2. Stop-loss: open <= entry - 2.0 * ATR at entry
  3. Time stop: held >= 10 bars and still red (open < entry)

Risk: 2% per trade via ATR-based sizing, 50% max position.

Lookahead: indicators computed from closes of PREVIOUS bars only.
Entry/exit decisions use bar["open"] exclusively.
"""

import math
from collections import deque


class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}

        self.rsi_period = p.get("rsi_period", 14)
        self.sma_period = p.get("sma_period", 50)
        self.atr_period = p.get("atr_period", 14)
        self.rsi_entry = p.get("rsi_entry", 30.0)
        self.take_profit_pct = p.get("take_profit_pct", 0.06)
        self.stop_atr_mult = p.get("stop_atr_mult", 2.0)
        self.max_hold_bars = p.get("max_hold_bars", 10)
        self.risk_per_trade = p.get("risk_per_trade", 0.02)
        self.max_position_pct = p.get("max_position_pct", 0.50)
        self.min_atr_ratio = p.get("min_atr_ratio", 0.005)
        self.max_atr_ratio = p.get("max_atr_ratio", 0.10)

        maxlen = max(self.sma_period, self.rsi_period, self.atr_period) + 5
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

    def _rsi(self):
        if len(self.closes) < self.rsi_period + 1:
            return None
        recent = list(self.closes)[-(self.rsi_period + 1):]
        gains, losses = 0.0, 0.0
        for i in range(1, len(recent)):
            delta = recent[i] - recent[i - 1]
            if delta > 0:
                gains += delta
            else:
                losses -= delta
        avg_gain = gains / self.rsi_period
        avg_loss = losses / self.rsi_period
        if avg_loss < 1e-10:
            return 100.0
        rs = avg_gain / avg_loss
        return 100.0 - (100.0 / (1.0 + rs))

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

        # EXIT before updating history (decisions on open, indicators on prior bars)
        if position > 0 and self.entry_price is not None:
            self.bars_held += 1
            stop_price = self.entry_price - self.stop_atr_mult * self.entry_atr
            take_price = self.entry_price * (1.0 + self.take_profit_pct)
            time_stop = self.bars_held >= self.max_hold_bars and open_p < self.entry_price

            if open_p <= stop_price or open_p >= take_price or time_stop:
                self.broker.sell(symbol, qty=position)
                self.entry_price = None
                self.entry_atr = None
                self.bars_held = 0
                self._update_history(bar)
                return

        # Compute indicators from history (excludes current bar)
        rsi = self._rsi()
        sma = self._sma(self.sma_period)
        atr = self._atr()

        # ENTRY
        if position == 0 and rsi is not None and sma is not None and atr is not None:
            atr_ratio = atr / open_p if open_p > 1e-10 else 0.0
            in_uptrend = open_p > sma
            oversold = rsi < self.rsi_entry
            vol_ok = self.min_atr_ratio <= atr_ratio <= self.max_atr_ratio

            if in_uptrend and oversold and vol_ok:
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
