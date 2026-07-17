"""Risk-adjusted ratios over equity / returns."""

from __future__ import annotations

import math
from typing import Optional

import numpy as np

from . import returns as ret_mod
from . import risk as risk_mod
from . import drawdown as dd_mod


def sharpe(returns: np.ndarray, bars_per_year: float, rf_annual: float = 0.0) -> float:
    if returns.size < 2:
        return 0.0
    rf_per_bar = rf_annual / bars_per_year
    excess = returns - rf_per_bar
    sd = float(excess.std(ddof=0))
    if sd <= 1e-12:
        return 0.0
    return float(excess.mean() / sd * math.sqrt(bars_per_year))


def sortino(returns: np.ndarray, bars_per_year: float, rf_annual: float = 0.0) -> float:
    if returns.size < 2:
        return 0.0
    rf_per_bar = rf_annual / bars_per_year
    excess = returns - rf_per_bar
    dd = risk_mod.downside_deviation(excess, mar=0.0)
    if dd <= 1e-12:
        return 0.0
    return float(excess.mean() / dd * math.sqrt(bars_per_year))


def calmar(equity: np.ndarray, ts_ns: np.ndarray) -> Optional[float]:
    c = ret_mod.cagr(equity, ts_ns)
    mdd = dd_mod.max_drawdown(equity)
    if c is None or mdd == 0:
        return None
    return float(c / abs(mdd))


def omega(returns: np.ndarray, threshold: float = 0.0) -> Optional[float]:
    if returns.size < 2:
        return 0.0
    pos = float(np.sum(np.maximum(returns - threshold, 0.0)))
    neg = float(np.sum(np.maximum(threshold - returns, 0.0)))
    if neg <= 0:
        return 0.0 if pos == 0 else None
    return float(pos / neg)


def mar(equity: np.ndarray, ts_ns: np.ndarray) -> Optional[float]:
    return calmar(equity, ts_ns)


def sterling(equity: np.ndarray, ts_ns: np.ndarray) -> Optional[float]:
    c = ret_mod.cagr(equity, ts_ns)
    avg_dd = dd_mod.avg_drawdown(equity)
    if c is None or avg_dd == 0:
        return None
    return float(c / abs(avg_dd))


def k_ratio(equity: np.ndarray) -> float:
    """K-ratio: slope of linear regression on cumulative log-equity, normalized
    by standard error of the slope. Measures consistency of returns."""
    if equity.size < 30:
        return 0.0
    y = np.log(np.clip(equity, 1e-12, None))
    x = np.arange(y.size, dtype=np.float64)
    xm, ym = x.mean(), y.mean()
    sxx = float(np.sum((x - xm) ** 2))
    sxy = float(np.sum((x - xm) * (y - ym)))
    if sxx <= 0:
        return 0.0
    slope = sxy / sxx
    residuals = y - (ym + slope * (x - xm))
    se = float(np.sqrt(np.sum(residuals ** 2) / (y.size - 2)) / np.sqrt(sxx))
    if se <= 0:
        return 0.0
    return float(slope / se)
