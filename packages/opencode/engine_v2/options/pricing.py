"""Black-Scholes option pricing — pure Python, no scipy dependency.

All functions use a rational approximation for the standard normal CDF
so they work inside the sandboxed strategy worker.
"""

from __future__ import annotations

import math

_SQRT2 = math.sqrt(2.0)
_SQRT2PI = math.sqrt(2.0 * math.pi)


def _norm_cdf(x: float) -> float:
    """Standard normal CDF via Abramowitz & Stegun rational approximation.

    Maximum absolute error < 7.5e-8 across the entire real line.
    """
    if x < -8.0:
        return 0.0
    if x > 8.0:
        return 1.0
    # Horner coefficients (A&S 26.2.17)
    p = 0.2316419
    b1 = 0.319381530
    b2 = -0.356563782
    b3 = 1.781477937
    b4 = -1.821255978
    b5 = 1.330274429
    t = 1.0 / (1.0 + p * abs(x))
    pdf = math.exp(-0.5 * x * x) / _SQRT2PI
    poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t
    cdf = 1.0 - pdf * poly
    return cdf if x >= 0 else 1.0 - cdf


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / _SQRT2PI


def _d1d2(S: float, K: float, T: float, r: float, sigma: float) -> tuple[float, float]:
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.0, 0.0
    sqrt_T = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    d2 = d1 - sigma * sqrt_T
    return d1, d2


def black_scholes_call(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if T <= 0:
        return max(S - K, 0.0)
    d1, d2 = _d1d2(S, K, T, r, sigma)
    return S * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)


def black_scholes_put(S: float, K: float, T: float, r: float, sigma: float) -> float:
    if T <= 0:
        return max(K - S, 0.0)
    d1, d2 = _d1d2(S, K, T, r, sigma)
    return K * math.exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)


def option_price(S: float, K: float, T: float, r: float, sigma: float, right: str) -> float:
    if right.upper() == "C":
        return black_scholes_call(S, K, T, r, sigma)
    if right.upper() == "P":
        return black_scholes_put(S, K, T, r, sigma)
    raise ValueError(f"right must be 'C' or 'P', got {right!r}")
