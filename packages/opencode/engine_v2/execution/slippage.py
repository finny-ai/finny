"""Dynamic slippage model:

  slip_bps = base_bps + k_atr * (atr / price) * 10_000 + k_vol * (qty / bar_volume) * 10_000

Returns slippage in *price units* (signed against the trade — buys lift, sells
drop). When ATR or volume isn't available, falls back to base_bps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class SlippageConfig:
    base_bps: float = 1.0
    k_atr: float = 0.5      # multiplier on (atr/price) contribution
    k_vol: float = 5.0      # multiplier on (qty/bar_volume) contribution
    max_bps: float = 200.0  # safety cap


def slippage_price_delta(
    side: str,
    price: float,
    qty: float,
    bar_volume: Optional[float],
    atr_value: Optional[float],
    cfg: SlippageConfig,
) -> float:
    if price <= 0:
        return 0.0
    bps = cfg.base_bps
    if atr_value is not None and atr_value == atr_value and price > 0:  # nan-safe
        bps += cfg.k_atr * (atr_value / price) * 10_000.0
    if bar_volume is not None and bar_volume > 0:
        bps += cfg.k_vol * (qty / bar_volume) * 10_000.0
    bps = max(0.0, min(bps, cfg.max_bps))
    delta = price * (bps / 10_000.0)
    return delta if side == "buy" else -delta
