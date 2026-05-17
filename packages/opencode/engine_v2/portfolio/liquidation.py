"""Intra-bar liquidation. When bar [open, high, low, close] contains the
liquidation price for a leveraged position, the broker liquidates at that
liq price with adverse slip; logged as a LIQUIDATION trade row."""

from __future__ import annotations

from typing import Optional

from .positions import Position


def liquidation_price(
    pos: Position, equity: float, curr_price: float, maintenance_pct: float
) -> Optional[float]:
    """Price at which `equity_at_P ≈ maintenance_pct * |qty| * P`.

    Derivation:
      equity_at_P = equity + qty*(P - curr)
      Set equal to mp * |qty| * P, then solve for P:
        equity + qty*P - qty*curr = mp*|qty|*P
        P * (qty - mp*|qty|*sign(qty)) = qty*curr - equity
        P = (qty*curr - equity) / (qty - mp*|qty|*sign(qty))

    For longs (qty>0), denominator simplifies to qty*(1 - mp); P < curr when
    equity > 0. For shorts (qty<0), liq is above curr.
    """
    if pos.qty == 0:
        return None
    abs_qty = abs(pos.qty)
    sgn = 1.0 if pos.qty > 0 else -1.0
    denom = pos.qty - maintenance_pct * abs_qty * sgn
    if denom == 0:
        return None
    p = (pos.qty * curr_price - equity) / denom
    if p <= 0:
        return None
    return float(p)


def detect_intra_bar_liquidation(
    pos: Position, bar_low: float, bar_high: float, liq_px: float
) -> bool:
    if pos.qty > 0:
        return bar_low <= liq_px
    if pos.qty < 0:
        return bar_high >= liq_px
    return False
