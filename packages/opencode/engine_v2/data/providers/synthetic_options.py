"""Synthetic options data provider.

Generates option OHLCV bars from underlying equity OHLCV using Black-Scholes.
This allows backtesting options strategies without expensive historical options
data feeds. The trade-off is well understood: constant-IV assumption, no skew,
European-style pricing.
"""

from __future__ import annotations

import sys
from typing import Optional

import numpy as np
import pandas as pd

from .yfinance import YFinanceProvider
from ...options.symbols import parse_option_symbol
from ...options.pricing import option_price
from ...options.greeks import greeks as compute_greeks
from ...options.calendar import time_to_expiry_years


_DEFAULT_IV = 0.25
_DEFAULT_RISK_FREE_RATE = 0.05


class SyntheticOptionsProvider:
    name = "synthetic_options"

    def __init__(
        self,
        iv: float = _DEFAULT_IV,
        risk_free_rate: float = _DEFAULT_RISK_FREE_RATE,
    ):
        self._iv = iv
        self._r = risk_free_rate
        self._underlying_provider = YFinanceProvider()

    def supports_interval(self, interval: str) -> bool:
        return self._underlying_provider.supports_interval(interval)

    def fetch(
        self,
        symbol: str,
        start: str,
        end: str,
        interval: str,
        iv: Optional[float] = None,
    ) -> pd.DataFrame:
        opt = parse_option_symbol(symbol)
        sigma = iv if iv is not None else self._iv
        r = self._r

        underlying_df = self._underlying_provider.fetch(opt.underlying, start, end, interval)
        if underlying_df is None or underlying_df.empty:
            print(
                f"__FINNY_FETCH_ERROR__: empty_window: no underlying data for {opt.underlying}",
                file=sys.stderr,
            )
            raise RuntimeError("empty_window")

        timestamps = pd.to_datetime(underlying_df["timestamp"], utc=True)
        u_open = underlying_df["open"].to_numpy(dtype=np.float64)
        u_high = underlying_df["high"].to_numpy(dtype=np.float64)
        u_low = underlying_df["low"].to_numpy(dtype=np.float64)
        u_close = underlying_df["close"].to_numpy(dtype=np.float64)
        u_volume = underlying_df["volume"].to_numpy(dtype=np.float64)

        n = len(underlying_df)
        opt_open = np.empty(n)
        opt_high = np.empty(n)
        opt_low = np.empty(n)
        opt_close = np.empty(n)
        opt_volume = np.empty(n)
        arr_iv = np.full(n, sigma)
        arr_delta = np.empty(n)
        arr_gamma = np.empty(n)
        arr_theta = np.empty(n)
        arr_vega = np.empty(n)

        for i in range(n):
            ts_date = timestamps.iloc[i]
            T = time_to_expiry_years(opt.expiry, ts_date.to_pydatetime())

            if T <= 0:
                intrinsic_fn = (lambda s: max(s - opt.strike, 0.0)) if opt.is_call else (lambda s: max(opt.strike - s, 0.0))
                opt_open[i] = intrinsic_fn(u_open[i])
                opt_high[i] = intrinsic_fn(u_high[i]) if opt.is_call else intrinsic_fn(u_low[i])
                opt_low[i] = intrinsic_fn(u_low[i]) if opt.is_call else intrinsic_fn(u_high[i])
                opt_close[i] = intrinsic_fn(u_close[i])
                arr_delta[i] = 1.0 if (opt.is_call and u_close[i] > opt.strike) else (-1.0 if (opt.is_put and u_close[i] < opt.strike) else 0.0)
                arr_gamma[i] = 0.0
                arr_theta[i] = 0.0
                arr_vega[i] = 0.0
            else:
                opt_open[i] = option_price(u_open[i], opt.strike, T, r, sigma, opt.right)
                opt_close[i] = option_price(u_close[i], opt.strike, T, r, sigma, opt.right)

                prices_at_extremes = [
                    option_price(u_high[i], opt.strike, T, r, sigma, opt.right),
                    option_price(u_low[i], opt.strike, T, r, sigma, opt.right),
                ]
                opt_high[i] = max(opt_open[i], opt_close[i], *prices_at_extremes)
                opt_low[i] = min(opt_open[i], opt_close[i], *prices_at_extremes)

                g = compute_greeks(u_close[i], opt.strike, T, r, sigma, opt.right)
                arr_delta[i] = g["delta"]
                arr_gamma[i] = g["gamma"]
                arr_theta[i] = g["theta"]
                arr_vega[i] = g["vega"]

            opt_volume[i] = u_volume[i] * 0.1

        result = pd.DataFrame({
            "timestamp": timestamps,
            "open": opt_open,
            "high": opt_high,
            "low": opt_low,
            "close": opt_close,
            "volume": opt_volume,
            "underlying_close": u_close,
            "iv": arr_iv,
            "delta": arr_delta,
            "gamma": arr_gamma,
            "theta": arr_theta,
            "vega": arr_vega,
        })
        return result
