"""Liquidation-price math: long below spot, short above spot, multiplier scaling.

Guards the corrected derivation in engine_v2/portfolio/liquidation.py, which
applies the contract multiplier on both sides and uses the (1 - mp) factor for
longs vs (1 + mp) for shorts. An earlier version was off by ~multiplier and had
the short-side sign wrong.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.portfolio.positions import Position
from engine_v2.portfolio.liquidation import liquidation_price, detect_intra_bar_liquidation


def _equity_at(pos: Position, equity: float, curr: float, p: float) -> float:
    return equity + pos.qty * (p - curr) * pos.multiplier


def _maintenance_at(pos: Position, p: float, mp: float) -> float:
    return mp * abs(pos.qty) * p * pos.multiplier


def test_long_liquidation_below_spot():
    pos = Position(symbol="ES", qty=1.0, multiplier=50.0)
    lp = liquidation_price(pos, equity=12000.0, curr_price=5000.0, maintenance_pct=0.04)
    assert lp is not None
    assert lp < 5000.0
    assert abs(lp - 4958.3333333) < 1e-3
    # At the liquidation price, equity has decayed exactly to maintenance.
    assert abs(_equity_at(pos, 12000.0, 5000.0, lp) - _maintenance_at(pos, lp, 0.04)) < 1e-6


def test_short_liquidation_above_spot():
    pos = Position(symbol="ES", qty=-1.0, multiplier=50.0)
    lp = liquidation_price(pos, equity=12000.0, curr_price=5000.0, maintenance_pct=0.04)
    assert lp is not None
    assert lp > 5000.0
    assert abs(lp - 5038.4615384) < 1e-3
    assert abs(_equity_at(pos, 12000.0, 5000.0, lp) - _maintenance_at(pos, lp, 0.04)) < 1e-6


def test_multiplier_scales_liquidation_distance():
    """A larger multiplier means more leverage at the same qty/price/equity, so
    the liquidation price sits closer to spot."""
    near = liquidation_price(Position("A", qty=1.0, multiplier=50.0), 12000.0, 5000.0, 0.04)
    far = liquidation_price(Position("B", qty=1.0, multiplier=10.0), 12000.0, 5000.0, 0.04)
    assert near is not None and far is not None
    # Both are longs (liq below spot); the higher-multiplier position liquidates
    # at a price closer to the current price.
    assert (5000.0 - near) < (5000.0 - far)


def test_spot_multiplier_one():
    pos = Position(symbol="X", qty=10.0, multiplier=1.0)
    lp = liquidation_price(pos, equity=1000.0, curr_price=500.0, maintenance_pct=0.10)
    assert lp is not None
    assert lp < 500.0
    assert abs(_equity_at(pos, 1000.0, 500.0, lp) - _maintenance_at(pos, lp, 0.10)) < 1e-6


def test_flat_position_has_no_liquidation():
    assert liquidation_price(Position("X", qty=0.0, multiplier=1.0), 1000.0, 500.0, 0.1) is None


def test_intra_bar_detection_direction():
    long_pos = Position("X", qty=1.0, multiplier=50.0)
    short_pos = Position("X", qty=-1.0, multiplier=50.0)
    # Long liquidates when the bar trades down THROUGH the liq price.
    assert detect_intra_bar_liquidation(long_pos, bar_low=4900.0, bar_high=5100.0, liq_px=4958.3)
    assert not detect_intra_bar_liquidation(long_pos, bar_low=4970.0, bar_high=5100.0, liq_px=4958.3)
    # Short liquidates when the bar trades up THROUGH the liq price.
    assert detect_intra_bar_liquidation(short_pos, bar_low=4900.0, bar_high=5100.0, liq_px=5038.5)
    assert not detect_intra_bar_liquidation(short_pos, bar_low=4900.0, bar_high=5020.0, liq_px=5038.5)
