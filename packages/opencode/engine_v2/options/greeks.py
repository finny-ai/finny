"""Black-Scholes Greeks — pure Python, no scipy dependency."""

from __future__ import annotations

import math
from typing import Dict

from .pricing import _d1d2, _norm_cdf, _norm_pdf


def delta(S: float, K: float, T: float, r: float, sigma: float, right: str) -> float:
    if T <= 0:
        if right.upper() == "C":
            return 1.0 if S > K else 0.0
        return -1.0 if S < K else 0.0
    d1, _ = _d1d2(S, K, T, r, sigma)
    if right.upper() == "C":
        return _norm_cdf(d1)
    return _norm_cdf(d1) - 1.0


def gamma(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if T <= 0 or sigma <= 0 or S <= 0:
        return 0.0
    d1, _ = _d1d2(S, K, T, r, sigma)
    return _norm_pdf(d1) / (S * sigma * math.sqrt(T))


def theta(S: float, K: float, T: float, r: float, sigma: float, right: str) -> float:
    """Per-calendar-day theta (negative for long positions)."""
    if T <= 0:
        return 0.0
    d1, d2 = _d1d2(S, K, T, r, sigma)
    sqrt_T = math.sqrt(T)
    common = -(S * _norm_pdf(d1) * sigma) / (2.0 * sqrt_T)
    if right.upper() == "C":
        annual = common - r * K * math.exp(-r * T) * _norm_cdf(d2)
    else:
        annual = common + r * K * math.exp(-r * T) * _norm_cdf(-d2)
    return annual / 365.0


def vega(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Vega per 1% (0.01) move in IV."""
    if T <= 0:
        return 0.0
    d1, _ = _d1d2(S, K, T, r, sigma)
    return S * _norm_pdf(d1) * math.sqrt(T) * 0.01


def rho(S: float, K: float, T: float, r: float, sigma: float, right: str) -> float:
    """Rho per 1% (0.01) move in risk-free rate."""
    if T <= 0:
        return 0.0
    _, d2 = _d1d2(S, K, T, r, sigma)
    if right.upper() == "C":
        return K * T * math.exp(-r * T) * _norm_cdf(d2) * 0.01
    return -K * T * math.exp(-r * T) * _norm_cdf(-d2) * 0.01


def greeks(S: float, K: float, T: float, r: float, sigma: float, right: str) -> Dict[str, float]:
    return {
        "delta": delta(S, K, T, r, sigma, right),
        "gamma": gamma(S, K, T, r, sigma),
        "theta": theta(S, K, T, r, sigma, right),
        "vega": vega(S, K, T, r, sigma),
        "rho": rho(S, K, T, r, sigma, right),
    }
