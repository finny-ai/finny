"""Return-based metrics over an equity curve (numpy float64) aligned with a
timestamp array (int64 ns)."""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


def bar_returns(equity: np.ndarray) -> np.ndarray:
    if equity.size < 2:
        return np.zeros(0)
    prev = np.clip(equity[:-1], 1e-12, None)
    return (equity[1:] - prev) / prev


def total_return(equity: np.ndarray) -> float:
    if equity.size < 2 or equity[0] <= 0:
        return 0.0
    return float(equity[-1] / equity[0] - 1.0)


def cagr(equity: np.ndarray, ts_ns: np.ndarray) -> Optional[float]:
    if equity.size < 2 or equity[0] <= 0:
        return None
    days = (ts_ns[-1] - ts_ns[0]) / 86_400_000_000_000.0
    if days < 30.0:
        return None
    years = days / 365.0
    return float((equity[-1] / equity[0]) ** (1.0 / years) - 1.0)


def _resample_returns(equity: np.ndarray, ts_ns: np.ndarray, rule: str) -> pd.Series:
    if equity.size < 2:
        return pd.Series(dtype=float)
    ts = pd.to_datetime(ts_ns, unit="ns", utc=True)
    eq = pd.Series(equity, index=ts)
    grouped = eq.resample(rule).last().dropna()
    return grouped.pct_change().dropna()


def daily_extremes(equity: np.ndarray, ts_ns: np.ndarray) -> Tuple[float, float]:
    r = _resample_returns(equity, ts_ns, "1D")
    if r.empty:
        return 0.0, 0.0
    return float(r.min()), float(r.max())


def monthly_extremes(equity: np.ndarray, ts_ns: np.ndarray) -> Tuple[float, float]:
    r = _resample_returns(equity, ts_ns, "1ME")
    if r.empty:
        return 0.0, 0.0
    return float(r.min()), float(r.max())


def pct_positive_periods(equity: np.ndarray, ts_ns: np.ndarray, rule: str) -> Optional[float]:
    r = _resample_returns(equity, ts_ns, rule)
    if r.empty:
        return None
    return float((r > 0).mean())


def time_weighted_return(equity: np.ndarray) -> float:
    return total_return(equity)


def money_weighted_return(cashflows: List[Tuple[int, float]], ending_equity: float) -> Optional[float]:
    """IRR over external cashflows. Returns None when there are no cashflows
    beyond the implicit initial seed (which alone is just total_return)."""
    if not cashflows:
        return None
    # Use scipy.optimize.brentq on NPV = 0
    times = np.array([t for t, _ in cashflows], dtype=np.float64)
    amts = np.array([a for _, a in cashflows], dtype=np.float64)
    # Add terminal cashflow
    times = np.append(times, times[-1] + 1.0)
    amts = np.append(-amts, ending_equity)
    # Years from first cashflow
    t0 = times[0]
    yrs = (times - t0) / (86_400_000_000_000.0 * 365.0)

    def npv(r: float) -> float:
        return float(np.sum(amts / (1.0 + r) ** yrs))

    lo, hi = -0.95, 5.0
    if npv(lo) * npv(hi) > 0:
        return None
    for _ in range(60):
        mid = (lo + hi) / 2.0
        if npv(lo) * npv(mid) < 0:
            hi = mid
        else:
            lo = mid
    return float((lo + hi) / 2.0)
