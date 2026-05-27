"""Implied volatility solver — Newton-Raphson on Black-Scholes vega."""

from __future__ import annotations

import math

from .pricing import option_price, _d1d2, _norm_pdf


def _bs_vega_annual(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Vega in annual (non-percentage) terms: dPrice/dSigma."""
    if T <= 0 or sigma <= 0 or S <= 0:
        return 0.0
    d1, _ = _d1d2(S, K, T, r, sigma)
    return S * _norm_pdf(d1) * math.sqrt(T)


def implied_vol(
    market_price: float,
    S: float,
    K: float,
    T: float,
    r: float,
    right: str,
    initial_guess: float = 0.3,
    tol: float = 1e-6,
    max_iter: int = 50,
) -> float:
    """Solve for IV given a market price. Returns NaN if no convergence."""
    if T <= 0 or market_price <= 0 or S <= 0 or K <= 0:
        return float("nan")

    intrinsic = max(S - K, 0.0) if right.upper() == "C" else max(K - S, 0.0)
    if market_price < intrinsic - 1e-10:
        return float("nan")

    sigma = initial_guess
    for _ in range(max_iter):
        price = option_price(S, K, T, r, sigma, right)
        diff = price - market_price
        if abs(diff) < tol:
            return sigma
        v = _bs_vega_annual(S, K, T, r, sigma)
        if v < 1e-12:
            return float("nan")
        sigma -= diff / v
        if sigma <= 0:
            sigma = 0.001
    return float("nan")
