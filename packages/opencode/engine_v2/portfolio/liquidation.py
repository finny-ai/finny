"""Intra-bar liquidation. When bar [open, high, low, close] contains the
liquidation price for a leveraged position, the broker liquidates at that
liq price with adverse slip; logged as a LIQUIDATION trade row."""

from __future__ import annotations

from typing import Optional

from .positions import Position


def liquidation_price(
    pos: Position, equity: float, curr_price: float, maintenance_pct: float
) -> Optional[float]:
    """Price at which `equity_at_P ≈ maintenance_pct * |qty| * P * M`,
    where M is the contract multiplier (50 for ES, 100 for options, 1 for spot).

    Derivation:
      equity_at_P     = equity + qty*(P - curr)*M
      maintenance@P   = mp * |qty| * P * M
      Setting equal and solving for P:
        equity + qty*P*M - qty*curr*M = mp*|qty|*P*M
        P*M*(qty - mp*|qty|) = qty*curr*M - equity
        P = (qty*curr*M - equity) / (M*(qty - mp*|qty|))

      For longs  (qty>0, |qty|=qty):   denom = M*qty*(1 - mp), positive → P < curr
      For shorts (qty<0, |qty|=-qty):  denom = M*qty*(1 + mp), negative → P > curr

    Note: an earlier version applied `* sign(qty)` to the |qty| term inside the
    denominator. That cancelled the sign correctly for longs but produced the
    wrong factor (1-mp instead of 1+mp) for shorts, and the multiplier was
    missing on both sides, so liquidation prices for leveraged futures were
    silently off by ~50× and for shorts in the wrong direction. Both fixed here.
    """
    if pos.qty == 0:
        return None
    M = float(pos.multiplier) if pos.multiplier else 1.0
    denom = M * (pos.qty - maintenance_pct * abs(pos.qty))
    if denom == 0:
        return None
    p = (pos.qty * curr_price * M - equity) / denom
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
