"""Drawdown depth/duration/recovery + top-N drawdowns."""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np
import pandas as pd


@dataclass
class DrawdownPeriod:
    start_idx: int
    trough_idx: int
    end_idx: Optional[int]
    depth: float
    duration_bars: int
    recovery_bars: Optional[int]


def max_drawdown(equity: np.ndarray) -> float:
    if equity.size == 0:
        return 0.0
    peak = np.maximum.accumulate(equity)
    dd = equity / np.clip(peak, 1e-12, None) - 1.0
    # Insolvency: equity at or below zero is a total loss from peak.
    dd = np.where(equity <= 0.0, -1.0, dd)
    return float(dd.min())


def _all_periods(equity: np.ndarray) -> List[DrawdownPeriod]:
    out: List[DrawdownPeriod] = []
    n = equity.size
    if n < 2:
        return out
    peak = equity[0]
    peak_idx = 0
    in_dd = False
    trough_idx = 0
    trough_val = peak
    for i in range(1, n):
        v = equity[i]
        if v >= peak:
            # New high (or matched) — recovers any open drawdown, then resets peak.
            if in_dd:
                depth = float(trough_val / peak - 1.0)
                out.append(DrawdownPeriod(peak_idx, trough_idx, i, depth, trough_idx - peak_idx,
                                          i - trough_idx))
                in_dd = False
            peak = v
            peak_idx = i
            trough_val = v
            trough_idx = i
        else:
            # v < peak — genuine drawdown bar.
            if not in_dd:
                in_dd = True
                trough_val = v
                trough_idx = i
            elif v < trough_val:
                trough_val = v
                trough_idx = i
    if in_dd:
        depth = float(trough_val / peak - 1.0)
        out.append(DrawdownPeriod(peak_idx, trough_idx, None, depth,
                                  trough_idx - peak_idx, None))
    return out


def top_drawdowns(equity: np.ndarray, k: int = 5) -> List[DrawdownPeriod]:
    periods = _all_periods(equity)
    return sorted(periods, key=lambda p: p.depth)[:k]


def avg_drawdown(equity: np.ndarray) -> float:
    periods = _all_periods(equity)
    if not periods:
        return 0.0
    return float(np.mean([p.depth for p in periods]))


def avg_dd_duration(equity: np.ndarray) -> float:
    periods = _all_periods(equity)
    if not periods:
        return 0.0
    return float(np.mean([p.duration_bars for p in periods]))


def max_dd_periods(equity: np.ndarray) -> Tuple[int, Optional[int]]:
    """Returns (max_dd_duration_bars, max_dd_recovery_bars)."""
    periods = _all_periods(equity)
    if not periods:
        return 0, None
    worst = min(periods, key=lambda p: p.depth)
    return worst.duration_bars, worst.recovery_bars


def current_drawdown(equity: np.ndarray) -> float:
    if equity.size == 0:
        return 0.0
    return float(equity[-1] / np.maximum.accumulate(equity)[-1] - 1.0)
