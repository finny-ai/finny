"""Structure-of-arrays OHLCV container.

One BarArrays per symbol. Backed by float64 numpy. Random access in O(1) — no
pandas.iloc overhead in the hot loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Mapping, Tuple

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
    if period <= 0:
        raise ValueError(f"ATR period must be > 0, got {period}")
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
    low = df["low"].to_numpy(dtype=np.float64)
    c = df["close"].to_numpy(dtype=np.float64)
    v = df["volume"].to_numpy(dtype=np.float64)
    return BarArrays(symbol=symbol, ts=ts, open=o, high=h, low=low, close=c, volume=v, atr=_atr(h, low, c, atr_period))


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
        self._decision_phase = False

    def set_index(self, i: int) -> None:
        ii = int(i)
        if ii < 0 or ii >= self.n:
            raise IndexError(f"snapshot index out of range: {ii} (n={self.n})")
        self._i = ii

    @property
    def i(self) -> int:
        return self._i

    def set_decision_phase(self, active: bool) -> None:
        self._decision_phase = bool(active)

    def last_close(self, symbol: str) -> float:
        return float(self.arrays[symbol].close[self._i])

    def decision_price(self, symbol: str) -> float:
        return float(self.arrays[symbol].open[self._i])

    def visible_price(self, symbol: str) -> float:
        return self.decision_price(symbol) if self._decision_phase else self.last_close(symbol)

    def attach_regime_labels(
        self,
        symbol: str,
        vol_labels: "np.ndarray",
        trend_labels: "np.ndarray",
    ) -> None:
        """Pre-attach regime classification arrays for a symbol.

        Called once before the loop starts. The labels are looked up per-bar
        in decision_safe_bar() so strategies can read bar["vol_regime"] and
        bar["trend_regime"] at decision time.
        """
        key = f"_regime_vol_{symbol}"
        setattr(self, key, vol_labels)
        key2 = f"_regime_trend_{symbol}"
        setattr(self, key2, trend_labels)

    def decision_safe_bar(self, symbol: str) -> Dict[str, object]:
        from ..robustness.regime import VOL_LABELS, TREND_LABELS

        ba = self.arrays[symbol]
        prev = self._i - 1
        prev_open = float(ba.open[prev]) if prev >= 0 else None
        prev_high = float(ba.high[prev]) if prev >= 0 else None
        prev_low = float(ba.low[prev]) if prev >= 0 else None
        prev_close = float(ba.close[prev]) if prev >= 0 else None
        prev_volume = float(ba.volume[prev]) if prev >= 0 else None

        # Regime labels — injected by attach_regime_labels() before the loop.
        vol_arr = getattr(self, f"_regime_vol_{symbol}", None)
        trend_arr = getattr(self, f"_regime_trend_{symbol}", None)
        vol_regime = VOL_LABELS.get(int(vol_arr[self._i]), "warmup") if vol_arr is not None else "warmup"
        trend_regime = TREND_LABELS.get(int(trend_arr[self._i]), "warmup") if trend_arr is not None else "warmup"

        return {
            "timestamp": int(ba.ts[self._i]),
            "symbol": symbol,
            "open": float(ba.open[self._i]),
            "prev_open": prev_open,
            "prev_high": prev_high,
            "prev_low": prev_low,
            "prev_close": prev_close,
            "volume": prev_volume,
            "vol_regime": vol_regime,
            "trend_regime": trend_regime,
        }

    def history_records(self, symbol: str, limit: int) -> Tuple[Mapping[str, object], ...]:
        """Immutable completed-bar records ending before the current decision."""
        ba = self.arrays[symbol]
        safe_limit = max(0, int(limit))
        end = self._i if self._decision_phase else self._i + 1
        start = max(0, end - safe_limit)
        out: List[Mapping[str, object]] = []
        for j in range(start, end):
            out.append({
                "timestamp": int(ba.ts[j]),
                "symbol": symbol,
                "open": float(ba.open[j]),
                "high": float(ba.high[j]),
                "low": float(ba.low[j]),
                "close": float(ba.close[j]),
                "volume": float(ba.volume[j]),
            })
        return tuple(out)

    def history(self, symbol: str, limit: int) -> pd.DataFrame:
        """Pandas DataFrame view of completed bars only during decision time."""
        ba = self.arrays[symbol]
        end = self._i if self._decision_phase else self._i + 1
        start = max(0, end - limit)
        return pd.DataFrame({
            "ts": pd.to_datetime(ba.ts[start:end], unit="ns", utc=True),
            "open": ba.open[start:end],
            "high": ba.high[start:end],
            "low": ba.low[start:end],
            "close": ba.close[start:end],
            "volume": ba.volume[start:end],
        })
