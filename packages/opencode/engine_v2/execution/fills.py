"""Fill engine.

Two realism modes:

  - "v1_compat": orders submitted at bar i are processed at the start of bar
    i+1 and filled at bar i+1's close. Slippage flat base_bps. No partials,
    no through-trade requirement on limits. Matches legacy backtest.py.

  - "v2" (default): causal bar phases —
      open: market orders fill at bar open using prior-bar volume/ATR/spread.
      intrabar: limit/stop/trailing orders use current-bar OHLC after the
                strategy decision.
    Partials capped at `participation_pct * prior_bar_volume` aggregated across
    all orders on the symbol for the bar. Remainder carries forward; on TTL
    expiry the unfilled remainder cancels.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

from ..core.arrays import BarArrays
from ..assets import AssetSpec
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


@dataclass
class ParticipationBudget:
    """Aggregate participation cap per symbol/bar."""

    forecast_volume: float
    participation_pct: float
    used_qty: float = 0.0

    def remaining(self) -> float:
        if self.participation_pct >= 1.0:
            return float("inf")
        if self.forecast_volume <= 0:
            return 0.0
        return max(0.0, self.forecast_volume * self.participation_pct - self.used_qty)

    def record(self, qty: float) -> None:
        if qty > 0:
            self.used_qty += float(qty)


def volume_forecast(ba: BarArrays, i: int) -> float:
    """Prior completed-bar volume — decision-time-safe for open fills."""
    if i <= 0:
        return 0.0
    return float(ba.volume[i - 1])


def _prior_atr(ba: BarArrays, i: int) -> float:
    if i <= 0 or ba.atr is None:
        return float("nan")
    return float(ba.atr[i - 1])


def _completed_close_window(ba: BarArrays, i: int, lookback: int) -> np.ndarray:
    """Close window ending at the last completed bar (i-1)."""
    end = i
    start = max(0, end - lookback)
    return ba.close[start:end]


def _effective_fill_cfg(fill_cfg: FillConfig, asset_class: str) -> FillConfig:
    if asset_class != "option" or fill_cfg.spread is None:
        return fill_cfg
    from copy import copy
    effective = copy(fill_cfg)
    wider_spread = copy(fill_cfg.spread)
    wider_spread.min_bps = max(wider_spread.min_bps, 30.0)
    wider_spread.enabled = True
    effective.spread = wider_spread
    return effective


def _trailing_stop_triggered(
    order: Order,
    o: float,
    h: float,
    low: float,
    *,
    conservative: bool,
) -> Tuple[bool, float]:
    """Return (triggered, trigger_price).

    Conservative intrabar path: long exits assume low before high; short covers
    assume high before low — avoids hindsight trail updates.
    """
    if order.stop_price is None:
        return False, 0.0
    sp = float(order.stop_price)
    if order.side == "sell":
        if conservative:
            if low <= sp:
                return True, min(o, sp) if o <= sp else sp
            order.high_water = max(order.high_water, h)
            order.stop_price = order.high_water - float(order.trail_amount or 0.0)
            return False, 0.0
        order.high_water = max(order.high_water, h)
        order.stop_price = order.high_water - float(order.trail_amount or 0.0)
        triggered = low <= float(order.stop_price)
        if triggered:
            tp = float(order.stop_price)
            return True, min(o, tp) if o <= tp else tp
        return False, 0.0
    if conservative:
        if h >= sp:
            return True, max(o, sp) if o >= sp else sp
        if order.high_water == 0.0:
            order.high_water = low
        order.high_water = min(order.high_water, low) if order.high_water > 0 else low
        order.stop_price = order.high_water + float(order.trail_amount or 0.0)
        return False, 0.0
    if order.high_water == 0.0:
        order.high_water = low
    order.high_water = min(order.high_water, low) if order.high_water > 0 else low
    order.stop_price = order.high_water + float(order.trail_amount or 0.0)
    triggered = h >= float(order.stop_price)
    if triggered:
        tp = float(order.stop_price)
        return True, max(o, tp) if o >= tp else tp
    return False, 0.0


def _resolve_limit_trigger(order: Order, h: float, low: float) -> Optional[Tuple[float, bool, bool]]:
    if order.limit_price is None:
        raise ValueError(f"limit order {order.id} missing limit_price")
    lp = float(order.limit_price)
    traded_through = (order.side == "buy" and low < lp) or (order.side == "sell" and h > lp)
    if not traded_through:
        return None
    return lp, True, False


def _resolve_stop_trigger(
    order: Order, o: float, h: float, low: float,
) -> Optional[Tuple[float, bool, bool]]:
    if order.stop_price is None:
        raise ValueError(f"stop-like order {order.id} missing stop_price")
    sp = float(order.stop_price)
    triggered = (order.side == "buy" and h >= sp) or (order.side == "sell" and low <= sp)
    if not triggered:
        return None
    base_px = max(o, sp) if order.side == "buy" else min(o, sp)
    if order.order_type == "stop_limit":
        if order.limit_price is None:
            raise ValueError(f"stop_limit order {order.id} missing limit_price")
        lp = float(order.limit_price)
        if order.side == "buy" and low > lp:
            return None
        if order.side == "sell" and h < lp:
            return None
        return lp, True, False
    return base_px, False, True


def _resolve_trailing_trigger(
    order: Order, o: float, h: float, low: float,
) -> Optional[Tuple[float, bool, bool]]:
    if order.trail_amount is None:
        return None
    triggered, trigger_px = _trailing_stop_triggered(order, o, h, low, conservative=True)
    if not triggered:
        return None
    return trigger_px, False, True


def _finalize_participation_qty(
    order: Order,
    budget: ParticipationBudget,
    spec: Optional[AssetSpec],
    margin_check: Optional[Callable[[Order, float, float], float]],
    base_px: float,
) -> float:
    fill_qty = min(float(order.qty_remaining), budget.remaining())
    if spec is not None:
        fill_qty = spec.round_qty(fill_qty)
    if fill_qty <= 0:
        return 0.0
    if margin_check is not None:
        fill_qty = margin_check(order, fill_qty, base_px)
        if spec is not None:
            fill_qty = spec.round_qty(fill_qty)
    if fill_qty <= 0:
        return 0.0
    budget.record(fill_qty)
    return fill_qty


def _append_fill(
    *,
    fills: List[Fill],
    order: Order,
    fill_qty: float,
    fill_px: float,
    fee: float,
    i: int,
    ts_ns: int,
    is_maker: bool,
    drop_ids: List[str],
) -> None:
    full = fill_qty >= order.qty_remaining - 1e-12
    order.qty_remaining -= fill_qty
    fills.append(Fill(
        order.id, order.symbol, order.side, fill_qty, fill_px,
        fee, i, ts_ns, order.tag, is_maker, full,
        stop_distance=order.stop_distance_hint,
    ))
    if full:
        drop_ids.append(order.id)


def _finalize_queue(queue: List[Order], drop_ids: List[str]) -> None:
    if drop_ids:
        drop_set = set(drop_ids)
        queue[:] = [o for o in queue if o.id not in drop_set]


def _ttl_expired(order: Order, drop_ids: List[str]) -> bool:
    if order.qty_remaining <= 0:
        drop_ids.append(order.id)
        return True
    order.bars_alive += 1
    if order.ttl_bars is not None and order.bars_alive > order.ttl_bars:
        drop_ids.append(order.id)
        return True
    return False


def _price_open_market_fill(
    order: Order,
    o: float,
    fill_qty: float,
    forecast_v: float,
    prior_atr: float,
    close_win: np.ndarray,
    effective_cfg: FillConfig,
    spec: Optional[AssetSpec],
) -> float:
    slip = slippage_price_delta(
        order.side, o, fill_qty, forecast_v, prior_atr, effective_cfg.slippage,
    )
    spr = half_spread(close_win, effective_cfg.spread, o)
    fill_px = o + slip + (spr if order.side == "buy" else -spr)
    if spec is not None:
        fill_px = spec.round_price(fill_px)
    return fill_px


def _price_intrabar_fill(
    order: Order,
    base_px: float,
    fill_qty: float,
    slip_volume: float,
    slip_atr: float,
    close_win: np.ndarray,
    effective_cfg: FillConfig,
    *,
    is_maker: bool,
    apply_spread: bool,
    spec: Optional[AssetSpec],
) -> float:
    slip = slippage_price_delta(
        order.side, base_px, fill_qty, slip_volume, slip_atr, effective_cfg.slippage,
    )
    fill_px = base_px + slip
    if apply_spread and not is_maker:
        spr = half_spread(close_win, effective_cfg.spread, base_px)
        fill_px = base_px + slip + (spr if order.side == "buy" else -spr)
    if spec is not None:
        fill_px = spec.round_price(fill_px)
    return fill_px


def process_open_orders_for_bar(
    queue: List[Order],
    ba: BarArrays,
    i: int,
    costs: CostConfig,
    fill_cfg: FillConfig,
    asset_specs: Optional[Dict[str, AssetSpec]] = None,
    participation_budget: Optional[ParticipationBudget] = None,
    margin_check: Optional[Callable[[Order, float, float], float]] = None,
) -> List[Fill]:
    """Open-phase fills: market orders at bar open using prior-bar inputs only."""
    if i >= len(ba) or fill_cfg.mode == "v1_compat":
        return process_orders_for_bar(
            queue, ba, i, costs, fill_cfg, asset_specs,
            participation_budget=participation_budget, margin_check=margin_check,
        )
    o = float(ba.open[i])
    ts_ns = int(ba.ts[i])
    forecast_v = volume_forecast(ba, i)
    prior_atr = _prior_atr(ba, i)
    budget = participation_budget or ParticipationBudget(
        forecast_volume=forecast_v, participation_pct=fill_cfg.participation_pct,
    )
    close_win = _completed_close_window(ba, i, fill_cfg.spread.lookback_bars)
    fills: List[Fill] = []
    drop_ids: List[str] = []
    spec = asset_specs.get(ba.symbol) if asset_specs else None
    asset_class = spec.assetClass if spec else ""
    effective_cfg = _effective_fill_cfg(fill_cfg, asset_class)

    for order in list(queue):
        if order.symbol != ba.symbol or order.order_type != "market":
            continue
        if _ttl_expired(order, drop_ids):
            continue

        fill_qty = _finalize_participation_qty(order, budget, spec, margin_check, o)
        if fill_qty <= 0:
            continue

        fill_px = _price_open_market_fill(
            order, o, fill_qty, forecast_v, prior_atr, close_win, effective_cfg, spec,
        )
        fee = commission(
            fill_qty * fill_px * (spec.multiplier if spec is not None else 1.0),
            is_maker=False, cfg=costs, qty=fill_qty, asset_class=asset_class,
        )
        _append_fill(
            fills=fills, order=order, fill_qty=fill_qty, fill_px=fill_px, fee=fee,
            i=i, ts_ns=ts_ns, is_maker=False, drop_ids=drop_ids,
        )

    _finalize_queue(queue, drop_ids)
    return fills


def process_intrabar_orders_for_bar(
    queue: List[Order],
    ba: BarArrays,
    i: int,
    costs: CostConfig,
    fill_cfg: FillConfig,
    asset_specs: Optional[Dict[str, AssetSpec]] = None,
    participation_budget: Optional[ParticipationBudget] = None,
    margin_check: Optional[Callable[[Order, float, float], float]] = None,
) -> List[Fill]:
    """Intrabar conditional fills after strategy decision (limit/stop/trailing)."""
    if i >= len(ba) or fill_cfg.mode == "v1_compat":
        return []
    o = float(ba.open[i])
    h = float(ba.high[i])
    low = float(ba.low[i])
    slip_volume = volume_forecast(ba, i)
    slip_atr = _prior_atr(ba, i)
    ts_ns = int(ba.ts[i])
    budget = participation_budget or ParticipationBudget(
        forecast_volume=slip_volume, participation_pct=fill_cfg.participation_pct,
    )
    close_win = ba.close[max(0, i - fill_cfg.spread.lookback_bars + 1): i + 1]
    fills: List[Fill] = []
    drop_ids: List[str] = []
    spec = asset_specs.get(ba.symbol) if asset_specs else None
    asset_class = spec.assetClass if spec else ""
    effective_cfg = _effective_fill_cfg(fill_cfg, asset_class)

    for order in list(queue):
        if order.symbol != ba.symbol or order.order_type == "market":
            continue
        if _ttl_expired(order, drop_ids):
            continue

        if order.order_type == "trailing_stop":
            resolved = _resolve_trailing_trigger(order, o, h, low)
        elif order.order_type == "limit":
            resolved = _resolve_limit_trigger(order, h, low)
        elif order.order_type in ("stop", "stop_limit"):
            resolved = _resolve_stop_trigger(order, o, h, low)
        else:
            resolved = None
        if resolved is None:
            continue
        base_px, is_maker, apply_spread = resolved

        fill_qty = _finalize_participation_qty(order, budget, spec, margin_check, base_px)
        if fill_qty <= 0:
            continue

        fill_px = _price_intrabar_fill(
            order, base_px, fill_qty, slip_volume, slip_atr, close_win, effective_cfg,
            is_maker=is_maker, apply_spread=apply_spread, spec=spec,
        )
        fee = commission(
            fill_qty * fill_px * (spec.multiplier if spec is not None else 1.0),
            is_maker=is_maker, cfg=costs, qty=fill_qty, asset_class=asset_class,
        )
        _append_fill(
            fills=fills, order=order, fill_qty=fill_qty, fill_px=fill_px, fee=fee,
            i=i, ts_ns=ts_ns, is_maker=is_maker, drop_ids=drop_ids,
        )

    _finalize_queue(queue, drop_ids)
    return fills


def process_orders_for_bar(
    queue: List[Order],
    ba: BarArrays,
    i: int,
    costs: CostConfig,
    fill_cfg: FillConfig,
    asset_specs: Optional[Dict[str, AssetSpec]] = None,
    participation_budget: Optional[ParticipationBudget] = None,
    margin_check: Optional[Callable[[Order, float, float], float]] = None,
) -> List[Fill]:
    """Process all queued orders against bar `i` (v1_compat path or legacy callers)."""
    if i >= len(ba):
        return []
    if fill_cfg.mode == "v2":
        budget = participation_budget or ParticipationBudget(
            forecast_volume=volume_forecast(ba, i),
            participation_pct=fill_cfg.participation_pct,
        )
        open_fills = process_open_orders_for_bar(
            queue, ba, i, costs, fill_cfg, asset_specs,
            participation_budget=budget, margin_check=margin_check,
        )
        intrabar_fills = process_intrabar_orders_for_bar(
            queue, ba, i, costs, fill_cfg, asset_specs,
            participation_budget=budget, margin_check=margin_check,
        )
        return open_fills + intrabar_fills

    o = float(ba.open[i])
    h = float(ba.high[i])
    low = float(ba.low[i])
    c = float(ba.close[i])
    v = float(ba.volume[i])
    atr_v = float(ba.atr[i]) if ba.atr is not None else float("nan")
    ts_ns = int(ba.ts[i])
    fills: List[Fill] = []
    drop_ids: List[str] = []
    spec = asset_specs.get(ba.symbol) if asset_specs else None
    asset_class = spec.assetClass if spec else ""
    effective_cfg = _effective_fill_cfg(fill_cfg, asset_class)

    for order in list(queue):
        if order.symbol != ba.symbol:
            continue
        if _ttl_expired(order, drop_ids):
            continue

        fill_qty_max = order.qty_remaining
        if spec is not None:
            fill_qty_max = spec.round_qty(fill_qty_max)
        if fill_qty_max <= 0:
            continue
        is_maker = order.order_type == "limit"

        if order.order_type == "market":
            base_px = c
            slip = slippage_price_delta(order.side, base_px, fill_qty_max, v, atr_v, effective_cfg.slippage)
            spr = half_spread(
                ba.close[max(0, i - effective_cfg.spread.lookback_bars + 1): i + 1],
                effective_cfg.spread, base_px,
            )
            fill_px = base_px + slip + (spr if order.side == "buy" else -spr)
            if spec is not None:
                fill_px = spec.round_price(fill_px)
            fee = commission(
                fill_qty_max * fill_px * (spec.multiplier if spec is not None else 1.0),
                is_maker=False, cfg=costs, qty=fill_qty_max, asset_class=asset_class,
            )
            _append_fill(
                fills=fills, order=order, fill_qty=fill_qty_max, fill_px=fill_px, fee=fee,
                i=i, ts_ns=ts_ns, is_maker=False, drop_ids=drop_ids,
            )
            continue

        if order.order_type == "limit":
            if order.limit_price is None:
                raise ValueError(f"limit order {order.id} missing limit_price")
            lp = float(order.limit_price)
            traded_through = (order.side == "buy" and lp >= low) or (order.side == "sell" and lp <= h)
            if not traded_through:
                continue
            base_px = lp
            slip = slippage_price_delta(order.side, base_px, fill_qty_max, v, atr_v, effective_cfg.slippage)
            fill_px = base_px + slip
            if spec is not None:
                fill_px = spec.round_price(fill_px)
            fee = commission(
                fill_qty_max * fill_px * (spec.multiplier if spec is not None else 1.0),
                is_maker=True, cfg=costs, qty=fill_qty_max, asset_class=asset_class,
            )
            _append_fill(
                fills=fills, order=order, fill_qty=fill_qty_max, fill_px=fill_px, fee=fee,
                i=i, ts_ns=ts_ns, is_maker=True, drop_ids=drop_ids,
            )
            continue

        if order.order_type in ("stop", "stop_limit", "trailing_stop"):
            if order.order_type == "trailing_stop" and order.trail_amount is not None:
                if order.side == "sell":
                    order.high_water = max(order.high_water, h)
                    order.stop_price = order.high_water - float(order.trail_amount)
                else:
                    if order.high_water == 0.0:
                        order.high_water = low
                    order.high_water = min(order.high_water, low) if order.high_water > 0 else low
                    order.stop_price = order.high_water + float(order.trail_amount)
            if order.stop_price is None:
                raise ValueError(f"stop-like order {order.id} missing stop_price")
            sp = float(order.stop_price)
            triggered = (order.side == "buy" and h >= sp) or (order.side == "sell" and low <= sp)
            if not triggered:
                continue
            base_px = max(o, sp) if order.side == "buy" else min(o, sp)
            if order.order_type == "stop_limit":
                if order.limit_price is None:
                    raise ValueError(f"stop_limit order {order.id} missing limit_price")
                lp = float(order.limit_price)
                if order.side == "buy" and low > lp:
                    continue
                if order.side == "sell" and h < lp:
                    continue
                base_px = lp
                is_maker = True
            else:
                is_maker = False
            slip = slippage_price_delta(order.side, base_px, fill_qty_max, v, atr_v, effective_cfg.slippage)
            fill_px = base_px + slip
            if spec is not None:
                fill_px = spec.round_price(fill_px)
            fee = commission(
                fill_qty_max * fill_px * (spec.multiplier if spec is not None else 1.0),
                is_maker=is_maker, cfg=costs, qty=fill_qty_max, asset_class=asset_class,
            )
            _append_fill(
                fills=fills, order=order, fill_qty=fill_qty_max, fill_px=fill_px, fee=fee,
                i=i, ts_ns=ts_ns, is_maker=is_maker, drop_ids=drop_ids,
            )

    _finalize_queue(queue, drop_ids)
    return fills
