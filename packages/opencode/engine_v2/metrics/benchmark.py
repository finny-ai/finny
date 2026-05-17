"""Benchmark-relative metrics: alpha, beta, IR, capture ratios."""

from __future__ import annotations

import math
from typing import Dict, Optional

import numpy as np


def compute(
    strategy_returns: np.ndarray,
    benchmark_returns: np.ndarray,
    bars_per_year: float,
) -> Optional[Dict]:
    if strategy_returns.size < 30 or benchmark_returns.size < 30:
        return None
    n = min(strategy_returns.size, benchmark_returns.size)
    s = strategy_returns[-n:]
    b = benchmark_returns[-n:]

    var_b = float(b.var(ddof=0))
    if var_b <= 0:
        return None
    beta = float(np.cov(s, b, ddof=0)[0, 1] / var_b)
    alpha_per_bar = float(s.mean() - beta * b.mean())
    alpha_annual = float(alpha_per_bar * bars_per_year)

    corr = float(np.corrcoef(s, b)[0, 1])
    r_squared = float(corr ** 2)

    diff = s - b
    tracking_error = float(diff.std(ddof=0) * math.sqrt(bars_per_year))
    info_ratio = float((diff.mean() * bars_per_year) / tracking_error) if tracking_error > 0 else 0.0

    # Treynor: (mean_excess) / beta, annualized
    treynor = float((s.mean() * bars_per_year) / beta) if abs(beta) > 1e-9 else None

    # Up / down capture
    up_mask = b > 0
    dn_mask = b < 0
    up_capture = float(s[up_mask].mean() / b[up_mask].mean()) if up_mask.any() and b[up_mask].mean() != 0 else 0.0
    dn_capture = float(s[dn_mask].mean() / b[dn_mask].mean()) if dn_mask.any() and b[dn_mask].mean() != 0 else 0.0

    return {
        "alpha_annualized": alpha_annual,
        "beta": beta,
        "r_squared": r_squared,
        "correlation": corr,
        "tracking_error": tracking_error,
        "information_ratio": info_ratio,
        "treynor_ratio": treynor,
        "up_capture": up_capture,
        "down_capture": dn_capture,
    }
