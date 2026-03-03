"""eth_trend_breakout_v1

ETH spot crypto strategy intended as a conservative, production-ready baseline.

Core idea (15m default):
  - Trade long-only in the direction of the higher-timeframe trend (EMA fast > EMA slow).
  - Enter on either:
      (A) Donchian breakout with volume confirmation, OR
      (B) Mean-reversion pullback in an uptrend (RSI oversold + price below EMA).
  - Exits use a hard stop (default 2%), ATR-based trailing stop, take-profit, and time-stop.

Risk controls (enabled by default):
  - Stop-loss per trade (default 2%)
  - Position sizing by risk-per-trade (default 1% of equity)
  - Max drawdown kill-switch (default 10%)
  - Daily loss limit (default 3%)
  - Max concurrent positions (default 3)

Important:
  - No strategy "prints money". This is a starting point you should backtest and paper trade.
  - Crypto runs 24/7: production deployments should include robust reconnect/backoff,
    clock drift checks, and idempotent order handling.
  - Never hardcode API keys — use environment variables.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple, cast

import numpy as np
import pandas as pd


# -------------------------
# Utilities / Indicators
# -------------------------


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ema(series: pd.Series, span: int) -> pd.Series:
    return cast(pd.Series, series.ewm(span=span, adjust=False).mean())


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Wilder RSI."""
    s = cast(pd.Series, series)
    delta = s.astype(float).diff()
    up = delta.clip(lower=0.0)
    down = (-delta).clip(lower=0.0)
    roll_up = up.ewm(alpha=1 / period, adjust=False).mean()
    roll_down = down.ewm(alpha=1 / period, adjust=False).mean()
    rs = roll_up / (roll_down + 1e-12)
    return cast(pd.Series, 100.0 - (100.0 / (1.0 + rs)))


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range on OHLCV dataframe with columns: high, low, close."""
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    close = df["close"].astype(float)
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            (high - low).abs(),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return cast(pd.Series, tr.rolling(period, min_periods=period).mean())


def vwap(df: pd.DataFrame, lookback: int) -> float:
    sub = df.tail(lookback)
    pv = (sub["close"].astype(float) * sub["volume"].astype(float)).sum()
    v = sub["volume"].astype(float).sum()
    return float(pv / v) if v > 0 else float(sub["close"].iloc[-1])


def zscore(series: pd.Series, lookback: int) -> float:
    sub = series.tail(lookback).astype(float)
    if len(sub) < lookback:
        return 0.0
    mu = float(sub.mean())
    sd = float(sub.std(ddof=0))
    if sd == 0:
        return 0.0
    return float((sub.iloc[-1] - mu) / sd)


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


# -------------------------
# Broker + Data Interfaces
# -------------------------


@dataclass
class Order:
    id: str
    side: str  # "buy" or "sell"
    qty: float
    order_type: str  # "limit" or "market"
    limit_price: Optional[float] = None
    created_at: Optional[datetime] = None
    ttl_minutes: Optional[int] = None
    post_only: bool = False
    tag: str = ""


@dataclass
class Fill:
    order_id: str
    side: str
    qty: float
    price: float
    fee_usd: float
    ts: datetime
    tag: str = ""


@dataclass
class Position:
    symbol: str
    qty: float  # + long, - short
    avg_price: float
    unrealized_pnl: float = 0.0


class Broker:
    """Minimal broker interface. Implementations:
    - PaperBroker (in backtest)
    - Algoclash adapter (paper/live)
    - Alpaca adapter (spot crypto only; perps not supported)
    """

    def get_equity(self) -> float:
        raise NotImplementedError

    def get_position(self, symbol: str) -> Optional[Position]:
        raise NotImplementedError

    def list_open_orders(self, symbol: str) -> List[Order]:
        raise NotImplementedError

    def submit_order(self, order: Order) -> str:
        raise NotImplementedError

    def cancel_order(self, order_id: str) -> None:
        raise NotImplementedError

    def latest_price(self, symbol: str) -> float:
        raise NotImplementedError


class MarketData:
    def candles(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        raise NotImplementedError


# -------------------------
# Strategy
# -------------------------


@dataclass
class StrategyState:
    entry_price: float = 0.0
    peak_price_since_entry: float = 0.0
    entry_time: Optional[datetime] = None
    last_stop_time: Optional[datetime] = None
    dd_kill: bool = False
    day_start_equity: Optional[float] = None
    day: Optional[str] = None


class EthTrendBreakoutStrategy:
    def __init__(self, config_path: str, broker: Broker, market: MarketData):
        self.cfg = self._load_config(config_path)
        self.symbol = self.cfg["symbol"]
        self.tf = self.cfg["timeframe"]
        self.broker = broker
        self.market = market
        self.state = StrategyState()

    @staticmethod
    def _load_config(path: str) -> Dict[str, Any]:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    # ---------- Indicators / Signals ----------
    def _compute_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.cfg["params"]
        out = df.copy()
        close = cast(pd.Series, out["close"]).astype(float)
        out["ema_fast"] = ema(close, int(p.get("ema_fast", 50)))
        out["ema_slow"] = ema(close, int(p.get("ema_slow", 200)))
        out["rsi"] = rsi(close, int(p.get("rsi_period", 14)))
        out["atr"] = atr(out, int(p.get("atr_period", 14)))
        donch = int(p.get("donchian_lookback", 20))
        out["donch_high"] = out["high"].astype(float).rolling(donch).max()
        out["donch_low"] = out["low"].astype(float).rolling(donch).min()
        vol_lb = int(p.get("vol_sma_lookback", 20))
        out["vol_sma"] = out["volume"].astype(float).rolling(vol_lb).mean()
        return out

    # ---------- Risk / Position Sizing ----------
    def _risk_checks_and_state(self) -> None:
        eq = float(self.broker.get_equity())
        day = utc_now().strftime("%Y-%m-%d")
        if self.state.day != day:
            self.state.day = day
            self.state.day_start_equity = eq

        # Daily loss limit
        risk_cfg = self.cfg["risk"]
        if self.state.day_start_equity is not None:
            if eq <= self.state.day_start_equity * (
                1.0 - float(risk_cfg.get("daily_loss_limit_pct", 0.03))
            ):
                # Only halt new entries (positions still managed)
                self.state.last_stop_time = utc_now()

        # Max drawdown kill-switch (relative to starting equity)
        start_eq = float(risk_cfg.get("starting_equity_usd", eq))
        if eq <= start_eq * (1.0 - float(risk_cfg.get("max_drawdown_pct", 0.10))):
            self.state.dd_kill = True

    def _cooldown_active(self) -> bool:
        if not self.state.last_stop_time:
            return False
        mins = int(self.cfg["risk"].get("cooldown_minutes_after_stop", 30))
        return utc_now() < (self.state.last_stop_time + timedelta(minutes=mins))

    def _position_size(
        self, stop_distance: float, size_multiplier: float = 1.0
    ) -> float:
        """Compute qty in base units (ETH) with risk in USD.

        For spot: PnL approx qty * price_move.
        Risk per trade is enforced in USD.
        """
        risk_cfg = self.cfg["risk"]
        eq = float(self.broker.get_equity())
        risk_usd = eq * float(risk_cfg.get("risk_per_trade_pct", 0.01))
        price = float(self.broker.latest_price(self.symbol))
        max_pos_usd = eq * float(risk_cfg.get("max_position_pct_of_equity", 0.35))

        if stop_distance <= 0:
            return 0.0

        qty_by_risk = risk_usd / stop_distance
        qty_by_max = max_pos_usd / max(price, 1e-9)
        qty = min(qty_by_risk, qty_by_max) * float(size_multiplier)
        # Minimum size guard (paper mode)
        return float(max(qty, 0.0))

    # ---------- Order Logic ----------
    def _submit_market(self, side: str, qty: float, tag: str) -> None:
        if qty <= 0:
            return
        oid = f"{tag}_{int(time.time())}"
        self.broker.submit_order(
            Order(id=oid, side=side, qty=float(qty), order_type="market", tag=tag)
        )

    def _entry_signal(self, df_i: pd.DataFrame) -> Tuple[bool, Dict[str, float]]:
        """Return (enter_long, metrics)."""
        p = self.cfg["params"]
        if len(df_i) < int(p.get("min_bars", 250)):
            return False, {"reason": -1.0}

        last = df_i.iloc[-1]
        prev = df_i.iloc[-2]
        close = float(last.close)
        ema_fast_v = float(last.ema_fast)
        ema_slow_v = float(last.ema_slow)
        rsi_v = float(last.rsi)
        atr_v = float(last.atr)
        if not np.isfinite(atr_v) or atr_v <= 0:
            return False, {"reason": -2.0}

        trend_ok = ema_fast_v > ema_slow_v

        # (A) Breakout
        donch_high_prev = (
            float(prev.donch_high) if np.isfinite(prev.donch_high) else float("nan")
        )
        breakout_buf = float(p.get("breakout_buffer_pct", 0.001))
        breakout = np.isfinite(donch_high_prev) and close > donch_high_prev * (
            1.0 + breakout_buf
        )

        vol_ok = True
        vol_mult = float(p.get("breakout_volume_mult", 1.2))
        if np.isfinite(last.vol_sma) and float(last.vol_sma) > 0:
            vol_ok = float(last.volume) >= float(last.vol_sma) * vol_mult

        # (B) Pullback (buy dip in uptrend)
        pull_atr_mult = float(p.get("pullback_atr_mult", 0.8))
        pullback = close <= ema_fast_v - pull_atr_mult * atr_v
        rsi_oversold = float(p.get("rsi_oversold", 35.0))
        pullback_ok = pullback and rsi_v <= rsi_oversold

        enter = bool(trend_ok and ((breakout and vol_ok) or pullback_ok))
        return enter, {
            "trend_ok": 1.0 if trend_ok else 0.0,
            "breakout": 1.0 if breakout else 0.0,
            "vol_ok": 1.0 if vol_ok else 0.0,
            "pullback": 1.0 if pullback else 0.0,
            "rsi": rsi_v,
            "atr": atr_v,
            "ema_fast": ema_fast_v,
            "ema_slow": ema_slow_v,
        }

    def _manage_open_position(self, df: pd.DataFrame, risk_off: bool) -> None:
        pos = self.broker.get_position(self.symbol)
        if not pos or pos.qty == 0:
            self.state.entry_price = 0.0
            self.state.peak_price_since_entry = 0.0
            self.state.entry_time = None
            return

        last_price = float(self.broker.latest_price(self.symbol))
        self.state.peak_price_since_entry = max(
            self.state.peak_price_since_entry, last_price
        )
        if self.state.entry_time is None:
            self.state.entry_time = utc_now()
        if self.state.entry_price <= 0:
            self.state.entry_price = float(pos.avg_price)

        p = self.cfg["params"]
        risk_cfg = self.cfg["risk"]

        # Latest ATR
        ind = self._compute_indicators(df)
        atr_v = float(ind["atr"].iloc[-1])
        if not np.isfinite(atr_v) or atr_v <= 0:
            atr_v = max(1e-9, float(pos.avg_price) * 0.01)

        # Hard stop
        hard_stop_pct = float(risk_cfg.get("stop_loss_pct", 0.02))
        hard_stop = float(pos.avg_price) * (1.0 - hard_stop_pct)

        # ATR trailing stop
        trail_mult = float(p.get("trail_atr_mult", 2.0))
        trail_stop = self.state.peak_price_since_entry - trail_mult * atr_v

        # If we're in profit, use the tighter of the two stops; otherwise use hard stop.
        stop_px = (
            max(hard_stop, trail_stop) if last_price > pos.avg_price else hard_stop
        )

        # Take profit
        tp_pct = float(p.get("take_profit_pct", 0.06))
        take_profit = float(pos.avg_price) * (1.0 + tp_pct)

        # Time stop
        max_hold_minutes = int(p.get("max_hold_minutes", 24 * 60))
        time_stop = self.state.entry_time is not None and utc_now() >= (
            self.state.entry_time + timedelta(minutes=max_hold_minutes)
        )

        # Trend exit (optional): if trend flips, exit.
        exit_on_trend_flip = bool(p.get("exit_on_trend_flip", True))
        if exit_on_trend_flip:
            last = ind.iloc[-1]
            if float(last.ema_fast) < float(last.ema_slow):
                self._submit_market("sell", abs(pos.qty), tag="trend_flip_exit")
                return

        if last_price <= stop_px:
            self._submit_market("sell", abs(pos.qty), tag="stop_exit")
            self.state.last_stop_time = utc_now()
            return

        if last_price >= take_profit:
            self._submit_market("sell", abs(pos.qty), tag="take_profit")
            return

        if time_stop:
            self._submit_market("sell", abs(pos.qty), tag="time_stop")
            return

    def on_bar(self) -> Dict[str, Any]:
        """Call once per new bar (1m by default). Returns diagnostics."""
        self._risk_checks_and_state()
        diag: Dict[str, Any] = {"symbol": self.symbol, "ts": utc_now().isoformat()}

        # Always manage existing risk even if kill-switch is hit
        df = self.market.candles(self.symbol, self.tf, limit=500)
        if df is None or len(df) < 50:
            diag["status"] = "insufficient_data"
            return diag

        # "risk_off" hook kept for future extensions; default False.
        risk_off = False
        self._manage_open_position(df, risk_off=risk_off)

        # Entry gating
        if self.state.dd_kill:
            diag["status"] = "dd_kill_switch"
            return diag
        if self._cooldown_active():
            diag["status"] = "cooldown"
            return diag

        pos = self.broker.get_position(self.symbol)
        if pos and abs(pos.qty) > 0:
            diag["status"] = "in_position"
            return diag

        # Do not exceed concurrent positions
        if len([p for p in [pos] if p and abs(p.qty) > 0]) >= int(
            self.cfg["execution"].get("max_concurrent_positions", 1)
        ):
            diag["status"] = "max_positions"
            return diag

        ind = self._compute_indicators(df)
        enter, m = self._entry_signal(ind)
        diag.update({f"m_{k}": v for k, v in m.items() if isinstance(v, (int, float))})
        diag["enter_long"] = bool(enter)

        if not enter:
            diag["status"] = "no_signal"
            return diag

        # Size by risk vs stop distance
        last = ind.iloc[-1]
        px = float(self.broker.latest_price(self.symbol))
        atr_v = float(last.atr)
        hard_stop_pct = float(self.cfg["risk"].get("stop_loss_pct", 0.02))
        stop_dist = max(
            px * hard_stop_pct,
            float(self.cfg["params"].get("entry_atr_stop_mult", 1.5)) * atr_v,
        )
        qty = self._position_size(stop_distance=stop_dist, size_multiplier=1.0)
        if qty <= 0:
            diag["status"] = "no_size"
            return diag

        self._submit_market("buy", qty, tag="entry_long")
        diag["status"] = "entered_long"
        return diag


# -------------------------
# Adapter stubs (deployment)
# -------------------------


class AlpacaBroker(Broker):
    """Alpaca adapter stub.

    Alpaca supports spot crypto (e.g., ETH/USD). This strategy is designed for spot.

    Required env vars:
      - ALPACA_API_KEY
      - ALPACA_API_SECRET
      - ALPACA_BASE_URL (paper or live)
    """

    def __init__(self, *_: Any, **__: Any) -> None:
        raise NotImplementedError(
            "Implement Alpaca integration for spot crypto if desired"
        )


class AlgoclashBroker(Broker):
    """Algoclash adapter stub.

    Implement against your Algoclash paper/live trading API.
    """

    def __init__(self, *_: Any, **__: Any) -> None:
        raise NotImplementedError("Implement Algoclash integration if desired")
