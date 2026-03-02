"""btc_liq_funding_news_v1

Implements:
1) Liquidation Arbitrage ("catching knives") via wick/volume/liquidation-spike detection and laddered deep limit buys.
2) Funding-rate exploitation:
   - WARNING: True delta-neutral funding capture requires hedging (spot+perp). If you only trade a perp, this becomes a funding-biased
     mean-reversion long filter, not risk-free carry.
3) Sentiment-triggered spreads/risk-off: keyword-based news risk score widens entries and reduces size.

Crypto runs 24/7: production deployments should include robust reconnect/backoff, clock drift checks, and idempotent order handling.
Never hardcode API keys: use environment variables.
"""

from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None


# -------------------------
# Utilities / Indicators
# -------------------------


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


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
    return tr.rolling(period, min_periods=period).mean()


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

    def funding_rate(self, symbol: str) -> Optional[float]:
        return None

    def liquidation_notional_1m(self, symbol: str) -> Optional[float]:
        return None

    def recent_headlines(self, lookback_minutes: int) -> List[str]:
        return []


# -------------------------
# News Provider (GDELT)
# -------------------------


class GdeltNewsProvider:
    """Lightweight keyword scanning via GDELT 2.1 DOC API.

    No API key required, but availability is not guaranteed. In production, use a dedicated provider.
    """

    BASE = "https://api.gdeltproject.org/api/v2/doc/doc"

    def __init__(self) -> None:
        if requests is None:
            raise RuntimeError("requests is required for GDELT provider")

    def fetch_headlines(self, lookback_minutes: int) -> List[str]:
        # Query broad crypto/macro context; we later score using configured keywords.
        query = "(bitcoin OR btc OR crypto OR federal reserve OR inflation OR war OR sanctions)"
        params = {
            "query": query,
            "mode": "ArtList",
            "format": "json",
            "maxrecords": 50,
            "sort": "HybridRel",
            "timelinesmooth": 0,
        }
        try:
            r = requests.get(self.BASE, params=params, timeout=10)
            r.raise_for_status()
            data = r.json()
            arts = data.get("articles", []) or []
            # GDELT doesn't expose exact timestamps in all modes; we just take the latest list.
            return [a.get("title", "") for a in arts if a.get("title")]
        except Exception:
            return []


# -------------------------
# Strategy
# -------------------------


@dataclass
class StrategyState:
    peak_price_since_entry: float = 0.0
    entry_time: Optional[datetime] = None
    last_stop_time: Optional[datetime] = None
    dd_kill: bool = False
    day_start_equity: Optional[float] = None
    day: Optional[str] = None


class BtcLiqFundingSentimentStrategy:
    def __init__(self, config_path: str, broker: Broker, market: MarketData):
        self.cfg = self._load_config(config_path)
        self.symbol = self.cfg["symbol"]
        self.tf = self.cfg["timeframe"]
        self.broker = broker
        self.market = market
        self.state = StrategyState()

        sg = self.cfg.get("sentiment_guard", {})
        self.keywords = [k.lower() for k in sg.get("keywords", [])]
        self.news_provider = None
        if sg.get("enabled", True) and sg.get("news_provider") == "gdelt":
            try:
                self.news_provider = GdeltNewsProvider()
            except Exception:
                self.news_provider = None

    @staticmethod
    def _load_config(path: str) -> Dict[str, Any]:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    # ---------- Sentiment Guard ----------
    def _news_risk_score(self) -> float:
        sg = self.cfg["sentiment_guard"]
        if not sg.get("enabled", True):
            return 0.0
        lookback = int(sg.get("lookback_minutes", 30))
        headlines: List[str] = []
        if self.news_provider is not None:
            headlines = self.news_provider.fetch_headlines(lookback)
        else:
            headlines = self.market.recent_headlines(lookback)

        if not headlines:
            return 0.0

        score = 0.0
        for h in headlines:
            hl = h.lower()
            for kw in self.keywords:
                if kw in hl:
                    score += 1.0
        # Diminishing returns
        return float(math.log1p(score))

    # ---------- Liquidation Event Detection ----------
    def _liquidation_event(self, df: pd.DataFrame) -> Tuple[bool, Dict[str, float]]:
        la = self.cfg["liquidation_arbitrage"]

        if len(df) < max(la.get("vwap_lookback", 60), la.get("atr_period", 14)) + 2:
            return False, {}

        last = df.iloc[-1]
        o, h, l, c = (
            float(last.open),
            float(last.high),
            float(last.low),
            float(last.close),
        )
        rng = max(h - l, 1e-9)
        lower_wick = max(min(o, c) - l, 0.0)
        wick_ratio = lower_wick / rng

        atr_val = float(atr(df, int(la.get("atr_period", 14))).iloc[-1])
        vwap_val = vwap(df, int(la.get("vwap_lookback", 60)))
        dislocation = (vwap_val - c) / max(atr_val, 1e-9)

        vol_z = zscore(df["volume"], lookback=60)

        # Optional real liquidation feed
        liq_notional = self.market.liquidation_notional_1m(self.symbol)
        has_liq_feed = liq_notional is not None
        liq_ok = True
        if has_liq_feed:
            # Conservative default for paper: treat >= $25k notional/1m as "massive" for BTC.
            liq_ok = float(liq_notional) >= 25_000.0

        event = (
            wick_ratio >= float(la.get("wick_ratio_threshold", 0.55))
            and vol_z >= float(la.get("volume_zscore_threshold", 2.0))
            and dislocation >= float(la.get("dislocation_atr_threshold", 1.2))
            and liq_ok
        )
        metrics = {
            "wick_ratio": wick_ratio,
            "vol_z": vol_z,
            "dislocation_atr": dislocation,
            "atr": atr_val,
            "vwap": vwap_val,
            "liq_notional_1m": float(liq_notional)
            if liq_notional is not None
            else float("nan"),
        }
        return bool(event), metrics

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
        if eq <= start_eq * (1.0 - float(risk_cfg.get("max_drawdown_pct", 0.2))):
            self.state.dd_kill = True

    def _cooldown_active(self) -> bool:
        if not self.state.last_stop_time:
            return False
        mins = int(self.cfg["risk"].get("cooldown_minutes_after_stop", 30))
        return utc_now() < (self.state.last_stop_time + timedelta(minutes=mins))

    def _position_size(
        self, stop_distance: float, size_multiplier: float = 1.0
    ) -> float:
        """Compute base qty in BTC contracts/units (assumes linear perp in USD).

        For a linear BTCUSDT perp, PnL approx: qty_btc * price_move_usd.
        Risk per trade is enforced in USD; leverage controls margin, not risk.
        """
        risk_cfg = self.cfg["risk"]
        eq = float(self.broker.get_equity())
        risk_usd = eq * float(risk_cfg.get("risk_per_trade_pct", 0.01))
        price = float(self.broker.latest_price(self.symbol))
        max_pos_usd = (
            eq
            * float(risk_cfg.get("max_position_pct_of_equity", 0.35))
            * float(risk_cfg.get("max_leverage", 1))
        )

        if stop_distance <= 0:
            return 0.0

        qty_by_risk = risk_usd / stop_distance
        qty_by_max = max_pos_usd / max(price, 1e-9)
        qty = min(qty_by_risk, qty_by_max) * float(size_multiplier)
        # Minimum size guard (paper mode)
        return float(max(qty, 0.0))

    # ---------- Order Logic ----------
    def _place_liq_ladder(self, mid: float, atr_val: float, risk_off: bool) -> None:
        la = self.cfg["liquidation_arbitrage"]
        ladder = la["ladder"]
        levels = ladder.get("levels", [1.5, 2.5, 3.5])
        weights = ladder.get("weights", [0.5, 0.3, 0.2])

        sg = self.cfg["sentiment_guard"]
        depth_mult = (
            float(sg.get("entry_depth_multiplier_on_risk", 1.5)) if risk_off else 1.0
        )
        size_mult = float(sg.get("size_multiplier_on_risk", 0.25)) if risk_off else 1.0

        # Cancel any prior ladder orders
        for o in self.broker.list_open_orders(self.symbol):
            if o.tag.startswith("liq_ladder"):
                self.broker.cancel_order(o.id)

        # Stop distance for sizing: ATR-based with cap
        stop_cfg = la["stop"]
        raw_stop = float(stop_cfg.get("atr_mult", 1.2)) * atr_val
        max_stop_pct = float(stop_cfg.get("max_stop_pct", 0.03))
        stop_distance = min(raw_stop, mid * max_stop_pct)

        base_qty = self._position_size(
            stop_distance=stop_distance, size_multiplier=size_mult
        )
        if base_qty <= 0:
            return

        ttl = int(self.cfg["execution"].get("limit_order_ttl_minutes", 20))
        post_only = bool(self.cfg["execution"].get("use_post_only_limits", True))

        for i, (k, w) in enumerate(zip(levels, weights), start=1):
            px = mid - (float(k) * atr_val * depth_mult)
            qty = base_qty * float(w)
            if qty <= 0 or px <= 0:
                continue
            oid = f"liq_ladder_{i}_{int(time.time())}"
            self.broker.submit_order(
                Order(
                    id=oid,
                    side="buy",
                    qty=float(qty),
                    order_type="limit",
                    limit_price=float(px),
                    created_at=utc_now(),
                    ttl_minutes=ttl,
                    post_only=post_only,
                    tag="liq_ladder",
                )
            )

    def _manage_open_position(self, df: pd.DataFrame, risk_off: bool) -> None:
        la = self.cfg["liquidation_arbitrage"]
        tp = la["take_profit"]
        pos = self.broker.get_position(self.symbol)
        if not pos or pos.qty == 0:
            self.state.peak_price_since_entry = 0.0
            self.state.entry_time = None
            return

        last_price = float(self.broker.latest_price(self.symbol))
        self.state.peak_price_since_entry = max(
            self.state.peak_price_since_entry, last_price
        )
        if self.state.entry_time is None:
            self.state.entry_time = utc_now()

        # Compute ATR
        atr_val = float(atr(df, int(la.get("atr_period", 14))).iloc[-1])

        # Hard stop (synthetic): exit market if price falls beyond stop distance
        stop_cfg = la["stop"]
        raw_stop = float(stop_cfg.get("atr_mult", 1.2)) * atr_val
        max_stop_pct = float(stop_cfg.get("max_stop_pct", 0.03))
        stop_distance = min(raw_stop, pos.avg_price * max_stop_pct)
        stop_px = pos.avg_price - stop_distance

        if last_price <= stop_px:
            oid = f"stop_exit_{int(time.time())}"
            self.broker.submit_order(
                Order(
                    id=oid,
                    side="sell",
                    qty=abs(pos.qty),
                    order_type="market",
                    tag="stop_exit",
                )
            )
            self.state.last_stop_time = utc_now()
            return

        # Trailing take profit (activates after recovery)
        activate_after = float(tp.get("activate_after_atr", 0.8)) * atr_val
        trail = float(tp.get("trail_atr", 0.6)) * atr_val

        if self.state.peak_price_since_entry >= pos.avg_price + activate_after:
            trail_stop = self.state.peak_price_since_entry - trail
            if last_price <= trail_stop:
                oid = f"trail_tp_{int(time.time())}"
                self.broker.submit_order(
                    Order(
                        id=oid,
                        side="sell",
                        qty=abs(pos.qty),
                        order_type="market",
                        tag="trail_tp",
                    )
                )
                return

        # Time stop
        max_hold = int(tp.get("time_stop_minutes", 240))
        if self.state.entry_time and utc_now() >= (
            self.state.entry_time + timedelta(minutes=max_hold)
        ):
            oid = f"time_stop_{int(time.time())}"
            self.broker.submit_order(
                Order(
                    id=oid,
                    side="sell",
                    qty=abs(pos.qty),
                    order_type="market",
                    tag="time_stop",
                )
            )
            return

        # Funding-biased exit: if funding normalizes, reduce willingness to hold
        fe = self.cfg.get("funding_exploitation", {})
        if fe.get("enabled", True):
            fr = self.market.funding_rate(self.symbol)
            if fr is not None and float(fr) >= float(
                fe.get("funding_recover_threshold", -0.0001)
            ):
                # If we are barely green, take it.
                if last_price >= pos.avg_price * 1.001:
                    oid = f"funding_norm_exit_{int(time.time())}"
                    self.broker.submit_order(
                        Order(
                            id=oid,
                            side="sell",
                            qty=abs(pos.qty),
                            order_type="market",
                            tag="funding_norm_exit",
                        )
                    )

    def on_bar(self) -> Dict[str, Any]:
        """Call once per new bar (1m by default). Returns diagnostics."""
        self._risk_checks_and_state()
        diag: Dict[str, Any] = {"symbol": self.symbol, "ts": utc_now().isoformat()}

        # Always manage existing risk even if kill-switch is hit
        df = self.market.candles(self.symbol, self.tf, limit=500)
        if df is None or len(df) < 50:
            diag["status"] = "insufficient_data"
            return diag

        news_score = self._news_risk_score()
        sg = self.cfg["sentiment_guard"]
        risk_off = news_score >= float(sg.get("risk_score_threshold", 2.0))
        diag["news_risk_score"] = news_score
        diag["risk_off"] = risk_off

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

        # Detect liquidation event
        event, m = self._liquidation_event(df)
        diag.update({f"liq_{k}": v for k, v in m.items()})
        diag["liq_event"] = event
        if not event:
            diag["status"] = "no_signal"
            return diag

        # Funding filter: prefer negative funding after crash
        fe = self.cfg.get("funding_exploitation", {})
        fr = self.market.funding_rate(self.symbol)
        diag["funding_rate"] = float(fr) if fr is not None else None
        if fe.get("enabled", True) and fr is not None:
            if float(fr) > float(fe.get("funding_negative_threshold", -0.0005)):
                diag["status"] = "funding_not_negative_enough"
                return diag

        # Place ladder
        last_price = float(self.broker.latest_price(self.symbol))
        atr_val = float(m.get("atr", 0.0))
        if atr_val <= 0:
            diag["status"] = "bad_atr"
            return diag

        self._place_liq_ladder(mid=last_price, atr_val=atr_val, risk_off=risk_off)
        diag["status"] = "placed_ladder"
        return diag


# -------------------------
# Adapter stubs (deployment)
# -------------------------


class AlpacaBroker(Broker):
    """Alpaca adapter stub.

    Alpaca supports spot crypto (BTC/USD), not perpetual futures. If you run this strategy on Alpaca,
    you must disable funding/liquidation-feed features or treat them as external signals only.

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
