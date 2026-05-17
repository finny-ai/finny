"""Interval-aware synthetic spread. Off by default. When enabled, derives a
half-spread in price units from realized volatility (stdev of log returns over
N bars) scaled by an interval-specific k."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class SpreadConfig:
    enabled: bool = False
    k: float = 0.5
    lookback_bars: int = 30
    min_bps: float = 0.0


def half_spread(
    close_window: np.ndarray, cfg: SpreadConfig, current_price: float
) -> float:
    if not cfg.enabled or close_window.shape[0] < cfg.lookback_bars or current_price <= 0:
        return current_price * (cfg.min_bps / 10_000.0)
    rets = np.diff(np.log(np.clip(close_window[-cfg.lookback_bars:], 1e-12, None)))
    vol = float(np.std(rets, ddof=0)) if rets.size else 0.0
    bps_from_vol = cfg.k * vol * 10_000.0
    bps = max(cfg.min_bps, bps_from_vol)
    return current_price * (bps / 10_000.0)
