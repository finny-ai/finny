"""Equity-curve stability + heatmap + rolling stats."""

from __future__ import annotations

import math
from typing import Dict, Tuple

import numpy as np
import pandas as pd


def equity_r2(equity: np.ndarray) -> float:
    """R² of a linear regression on log-equity. Closer to 1 = smoother curve."""
    if equity.size < 10:
        return 0.0
    y = np.log(np.clip(equity, 1e-12, None))
    x = np.arange(y.size, dtype=np.float64)
    if y.std(ddof=0) == 0:
        return 1.0
    corr = float(np.corrcoef(x, y)[0, 1])
    return float(corr ** 2)


def rolling_sharpe(returns: np.ndarray, bars_per_year: float, window: int = 90) -> Tuple[float, float, float]:
    if returns.size < window + 5:
        return 0.0, 0.0, 0.0
    out = np.full(returns.size - window + 1, np.nan)
    cs = np.cumsum(returns)
    cs2 = np.cumsum(returns ** 2)
    for i in range(window, returns.size + 1):
        s = cs[i - 1] - (cs[i - window - 1] if i > window else 0.0)
        s2 = cs2[i - 1] - (cs2[i - window - 1] if i > window else 0.0)
        mean = s / window
        var = max(0.0, s2 / window - mean * mean)
        if var <= 0:
            out[i - window] = 0.0
        else:
            out[i - window] = float(mean / math.sqrt(var) * math.sqrt(bars_per_year))
    valid = out[~np.isnan(out)]
    if valid.size == 0:
        return 0.0, 0.0, 0.0
    return float(valid.mean()), float(valid.min()), float(valid.max())


def monthly_returns_heatmap(equity: np.ndarray, ts_ns: np.ndarray) -> Dict[str, Dict[str, float]]:
    if equity.size < 2:
        return {}
    ts = pd.to_datetime(ts_ns, unit="ns", utc=True)
    s = pd.Series(equity, index=ts).resample("1ME").last().dropna()
    rets = s.pct_change().dropna()
    out: Dict[str, Dict[str, float]] = {}
    for ts_, r in rets.items():
        y = f"{ts_.year}"
        m = f"{ts_.month:02d}"
        out.setdefault(y, {})[m] = float(r)
    return out
