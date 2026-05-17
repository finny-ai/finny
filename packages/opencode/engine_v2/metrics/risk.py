"""Risk metrics: vol, downside dev, VaR/CVaR, Ulcer, skew/kurt, tail ratio."""

from __future__ import annotations

import math
from typing import Tuple

import numpy as np


def ann_vol(returns: np.ndarray, bars_per_year: float) -> float:
    if returns.size < 2:
        return 0.0
    return float(returns.std(ddof=0) * math.sqrt(bars_per_year))


def downside_deviation(returns: np.ndarray, mar: float = 0.0) -> float:
    if returns.size < 2:
        return 0.0
    neg = np.minimum(returns - mar, 0.0)
    return float(math.sqrt((neg ** 2).mean()))


def semi_variance(returns: np.ndarray) -> float:
    if returns.size < 2:
        return 0.0
    neg = returns[returns < 0]
    if neg.size == 0:
        return 0.0
    return float((neg ** 2).mean())


def skewness(returns: np.ndarray) -> float:
    if returns.size < 3:
        return 0.0
    try:
        from scipy.stats import skew
        return float(skew(returns, bias=False, nan_policy="omit"))
    except ImportError:
        x = returns - returns.mean()
        m2 = float((x ** 2).mean())
        m3 = float((x ** 3).mean())
        return float(m3 / (m2 ** 1.5)) if m2 > 0 else 0.0


def kurtosis(returns: np.ndarray) -> float:
    if returns.size < 4:
        return 0.0
    try:
        from scipy.stats import kurtosis as kt
        return float(kt(returns, bias=False, nan_policy="omit"))
    except ImportError:
        x = returns - returns.mean()
        m2 = float((x ** 2).mean())
        m4 = float((x ** 4).mean())
        return float(m4 / (m2 ** 2) - 3.0) if m2 > 0 else 0.0


def value_at_risk(returns: np.ndarray, alpha: float = 0.95) -> float:
    if returns.size < 5:
        return 0.0
    q = float(np.quantile(returns, 1.0 - alpha))
    return -q


def conditional_var(returns: np.ndarray, alpha: float = 0.95) -> float:
    if returns.size < 5:
        return 0.0
    cutoff = float(np.quantile(returns, 1.0 - alpha))
    tail = returns[returns <= cutoff]
    if tail.size == 0:
        return 0.0
    return float(-tail.mean())


def drawdown_series(equity: np.ndarray) -> np.ndarray:
    if equity.size == 0:
        return np.zeros(0)
    peak = np.maximum.accumulate(equity)
    return (equity - peak) / np.clip(peak, 1e-12, None)


def ulcer_index(equity: np.ndarray) -> float:
    dd = drawdown_series(equity)
    return float(math.sqrt(np.mean(dd ** 2))) if dd.size else 0.0


def pain_index(equity: np.ndarray) -> float:
    dd = drawdown_series(equity)
    return float(-dd.mean()) if dd.size else 0.0


def tail_ratio(returns: np.ndarray) -> float:
    if returns.size < 20:
        return 0.0
    p95 = float(np.quantile(returns, 0.95))
    p5 = float(np.quantile(returns, 0.05))
    if abs(p5) < 1e-12:
        return 0.0
    return float(abs(p95) / abs(p5))
