"""Structure-of-arrays OHLCV container.

One BarArrays per symbol. Backed by float64 numpy. Random access in O(1) — no
pandas.iloc overhead in the hot loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import numpy as np
import pandas as pd


@dataclass
class BarArrays:
    symbol: str
    ts: np.ndarray  # int64 unix-ns
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    atr: np.ndarray  # precomputed; nan until period

    def __len__(self) -> int:
        return int(self.ts.shape[0])


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    n = close.shape[0]
    if n == 0:
        return np.zeros(0)
    prev_close = np.empty_like(close)
    prev_close[0] = close[0]
    prev_close[1:] = close[:-1]
    tr = np.maximum.reduce([
        high - low,
        np.abs(high - prev_close),
        np.abs(low - prev_close),
    ])
    # Simple rolling mean (Wilder's would compound earlier values; this matches v1's atr()).
    out = np.full(n, np.nan)
    if n < period:
        return out
    csum = np.cumsum(tr, dtype=np.float64)
    out[period - 1] = csum[period - 1] / period
    out[period:] = (csum[period:] - csum[:-period]) / period
    return out


def from_dataframe(df: pd.DataFrame, symbol: str, atr_period: int = 14) -> BarArrays:
    """Build BarArrays from a tidy OHLCV dataframe with a DatetimeIndex
    (UTC) or a 'timestamp' column."""
    # Force nanosecond resolution before int cast — pandas ≥ 2.0 may use
    # datetime64[us] when reading CSV with mixed-precision timestamps, and a
    # direct .astype("int64") would silently yield microseconds.
    if "timestamp" in df.columns:
        ts = pd.to_datetime(df["timestamp"], utc=True).astype("datetime64[ns, UTC]").astype("int64").to_numpy()
    else:
        ts = pd.to_datetime(df.index, utc=True).astype("datetime64[ns, UTC]").astype("int64").to_numpy()
    o = df["open"].to_numpy(dtype=np.float64)
    h = df["high"].to_numpy(dtype=np.float64)
    l = df["low"].to_numpy(dtype=np.float64)
    c = df["close"].to_numpy(dtype=np.float64)
    v = df["volume"].to_numpy(dtype=np.float64)
    return BarArrays(symbol=symbol, ts=ts, open=o, high=h, low=l, close=c, volume=v, atr=_atr(h, l, c, atr_period))


class MarketSnapshot:
    """Multi-symbol bar container with synced timeline.

    All BarArrays must share the same timeline (same ts array). Strategies
    receive views into this snapshot; the runtime advances an integer cursor.
    """

    def __init__(self, arrays: Dict[str, BarArrays]):
        if not arrays:
            raise ValueError("at least one symbol required")
        first = next(iter(arrays.values())).ts
        for sym, ba in arrays.items():
            if ba.ts.shape != first.shape or not np.array_equal(ba.ts, first):
                raise ValueError(f"timeline mismatch for {sym}; resample to a common grid first")
        self.arrays = arrays
        self.ts = first
        self.n = first.shape[0]
        self.symbols: List[str] = list(arrays.keys())
        self._i = 0

    def set_index(self, i: int) -> None:
        self._i = int(i)

    @property
    def i(self) -> int:
        return self._i

    def last_close(self, symbol: str) -> float:
        return float(self.arrays[symbol].close[self._i])

    def history(self, symbol: str, limit: int) -> pd.DataFrame:
        """Pandas DataFrame view of [i-limit+1, i] inclusive. Used by v1 compat."""
        ba = self.arrays[symbol]
        start = max(0, self._i - limit + 1)
        end = self._i + 1
        return pd.DataFrame({
            "ts": pd.to_datetime(ba.ts[start:end], unit="ns", utc=True),
            "open": ba.open[start:end],
            "high": ba.high[start:end],
            "low": ba.low[start:end],
            "close": ba.close[start:end],
            "volume": ba.volume[start:end],
        })
