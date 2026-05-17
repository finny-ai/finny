"""Fill engine.

Two realism modes:

  - "v1_compat": orders submitted at bar i are processed at the start of bar
    i+1 and filled at bar i+1's close. Slippage flat base_bps. No partials,
    no through-trade requirement on limits. Matches legacy backtest.py.

  - "v2" (default): orders submitted at bar i are filled at bar i+1's OPEN
    (market), only when bar i+1 trades through the limit (limit), and at the
    gap-adverse trigger price for stops. Partials capped at
    `participation_pct * bar_volume`. Remainder carries forward; on TTL expiry
    the unfilled remainder cancels (any filled portion stays as a real trade
    already booked at fill time).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from ..core.arrays import BarArrays
from .costs import CostConfig, commission
from .orders import Order
from .slippage import SlippageConfig, slippage_price_delta
from .spread import SpreadConfig, half_spread


@dataclass
class Fill:
    order_id: str
    symbol: str
    side: str
    qty: float
    price: float
    fee: float
    bar_index: int
    ts_ns: int
    tag: str
    is_maker: bool
    full: bool  # True if this fill closes the order (no remainder)
    stop_distance: Optional[float] = None


@dataclass
class FillConfig:
    mode: str = "v2"   # "v1_compat" | "v2"
    participation_pct: float = 0.10  # cap fill at this fraction of bar volume
    slippage: SlippageConfig = None  # type: ignore[assignment]
    spread: SpreadConfig = None      # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.mode not in {"v1_compat", "v2"}:
            raise ValueError(f"unsupported fill mode: {self.mode!r}")
        if not (0.0 <= self.participation_pct <= 1.0):
            raise ValueError(f"participation_pct must be in [0, 1], got {self.participation_pct}")
        if self.slippage is None:
            self.slippage = SlippageConfig()
        if self.spread is None:
            self.spread = SpreadConfig()


def _fill_qty(qty_remaining: float, bar_volume: float, cfg: FillConfig) -> float:
    if cfg.mode == "v1_compat":
        return qty_remaining
    # v2: zero-volume bars produce no fills — respect the participation cap.
    if bar_volume <= 0:
        return 0.0
    if cfg.participation_pct >= 1.0:
        return qty_remaining
    cap = bar_volume * cfg.participation_pct
    return min(qty_remaining, cap)


def _close_window(ba: BarArrays, i: int, lookback: int) -> np.ndarray:
    start = max(0, i - lookback)
    return ba.close[start:i + 1]


def process_orders_for_bar(
    queue: List[Order],
    ba: BarArrays,
    i: int,
    costs: CostConfig,
    fill_cfg: FillConfig,
) -> List[Fill]:
    """Process all queued orders against bar `i`. Returns fill records and
    mutates the queue in place (filled-fully + ttl-expired orders are removed,
    partials have qty_remaining decremented)."""
    if i >= len(ba):
        return []
    o = float(ba.open[i])
    h = float(ba.high[i])
    l = float(ba.low[i])
    c = float(ba.close[i])
    v = float(ba.volume[i])
    atr_v = float(ba.atr[i]) if ba.atr is not None else float("nan")
    ts_ns = int(ba.ts[i])
    fills: List[Fill] = []
    drop_ids: List[str] = []

    for order in list(queue):
        if order.symbol != ba.symbol:
            continue
        if order.qty_remaining <= 0:
            drop_ids.append(order.id)
            continue
        order.bars_alive += 1
        # TTL gating BEFORE attempting a fill: if the order is past its TTL it
        # gets cancelled this bar. Realized partials from prior bars already
        # exist as Fill rows.
        if order.ttl_bars is not None and order.bars_alive > order.ttl_bars:
            drop_ids.append(order.id)
            continue

        fill_qty_max = _fill_qty(order.qty_remaining, v, fill_cfg)
        if fill_qty_max <= 0:
            # Zero-volume bar (or fully throttled by participation cap) — no
            # fill this bar; remainder carries to the next under the same TTL.
            continue
        is_maker = order.order_type == "limit"

        # Trailing stop: convert trail into a stop_price based on high_water.
        if order.order_type == "trailing_stop" and order.trail_amount is not None:
            if order.side == "sell":
                order.high_water = max(order.high_water, h)
                order.stop_price = order.high_water - float(order.trail_amount)
            else:
                if order.high_water == 0.0:
                    order.high_water = l
                order.high_water = min(order.high_water, l) if order.high_water > 0 else l
                order.stop_price = order.high_water + float(order.trail_amount)

        # --- Market ---
        if order.order_type == "market":
            if fill_cfg.mode == "v1_compat":
                base_px = c
            else:
                base_px = o
            slip = slippage_price_delta(order.side, base_px, fill_qty_max, v, atr_v, fill_cfg.slippage)
            spr = half_spread(_close_window(ba, i, fill_cfg.spread.lookback_bars), fill_cfg.spread, base_px)
            fill_px = base_px + slip + (spr if order.side == "buy" else -spr)
            fee = commission(fill_qty_max * fill_px, is_maker=False, cfg=costs)
            full = (fill_qty_max >= order.qty_remaining)
            order.qty_remaining -= fill_qty_max
            fills.append(Fill(order.id, order.symbol, order.side, fill_qty_max, fill_px,
                              fee, i, ts_ns, order.tag, False, full,
                              stop_distance=order.stop_distance_hint))
            if full:
                drop_ids.append(order.id)
            continue

        # --- Limit ---
        if order.order_type == "limit":
            if order.limit_price is None:
                raise ValueError(f"limit order {order.id} missing limit_price")
            lp = float(order.limit_price)
            traded_through = (order.side == "buy" and l < lp) or (order.side == "sell" and h > lp)
            if fill_cfg.mode == "v1_compat":
                traded_through = (order.side == "buy" and lp >= l) or (order.side == "sell" and lp <= h)
            if not traded_through:
                continue
            base_px = lp
            slip = slippage_price_delta(order.side, base_px, fill_qty_max, v, atr_v, fill_cfg.slippage)
            fill_px = base_px + slip
            fee = commission(fill_qty_max * fill_px, is_maker=True, cfg=costs)
            full = (fill_qty_max >= order.qty_remaining)
            order.qty_remaining -= fill_qty_max
            fills.append(Fill(order.id, order.symbol, order.side, fill_qty_max, fill_px,
                              fee, i, ts_ns, order.tag, True, full,
                              stop_distance=order.stop_distance_hint))
            if full:
                drop_ids.append(order.id)
            continue

        # --- Stop (and stop_limit, trailing_stop) ---
        if order.order_type in ("stop", "stop_limit", "trailing_stop"):
            if order.stop_price is None:
                raise ValueError(f"stop-like order {order.id} missing stop_price")
            sp = float(order.stop_price)
            triggered = (order.side == "buy" and h >= sp) or (order.side == "sell" and l <= sp)
            if not triggered:
                continue
            # Gap-adverse: if open is already past stop, fill at open; else at stop.
            if order.side == "buy":
                trigger_px = max(o, sp)
            else:
                trigger_px = min(o, sp)
            if order.order_type == "stop_limit":
                if order.limit_price is None:
                    raise ValueError(f"stop_limit order {order.id} missing limit_price")
                lp = float(order.limit_price)
                # After trigger, behave as marketable limit during this bar
                if order.side == "buy" and l > lp:
                    continue
                if order.side == "sell" and h < lp:
                    continue
                base_px = lp
                is_maker = True
            else:
                base_px = trigger_px
                is_maker = False
            slip = slippage_price_delta(order.side, base_px, fill_qty_max, v, atr_v, fill_cfg.slippage)
            fill_px = base_px + slip
            fee = commission(fill_qty_max * fill_px, is_maker=is_maker, cfg=costs)
            full = (fill_qty_max >= order.qty_remaining)
            order.qty_remaining -= fill_qty_max
            fills.append(Fill(order.id, order.symbol, order.side, fill_qty_max, fill_px,
                              fee, i, ts_ns, order.tag, is_maker, full,
                              stop_distance=order.stop_distance_hint))
            if full:
                drop_ids.append(order.id)
            continue

    if drop_ids:
        drop_set = set(drop_ids)
        queue[:] = [o for o in queue if o.id not in drop_set]
    return fills
