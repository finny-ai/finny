"""yfinance adapter. Mirrors the fetch logic in src/backtest/runner.ts:138-205
so error-classification sentinels remain compatible."""

from __future__ import annotations

import sys
from typing import Dict

import pandas as pd

from ...assets import to_yfinance_symbol

_SUPPORTED = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}

_INTERVAL_MAP = {
    "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m",
    "1h": "1h", "4h": "4h", "1d": "1d",
}


def _normalize_yf(symbol: str) -> str:
    return to_yfinance_symbol(symbol)


class YFinanceProvider:
    name = "yfinance"

    def supports_interval(self, interval: str) -> bool:
        return interval in _SUPPORTED or interval in _INTERVAL_MAP

    def fetch(self, symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
        try:
            import yfinance as yf
        except ImportError as e:
            print(f"__FINNY_FETCH_ERROR__: python_env: yfinance import failed: {e}",
                  file=sys.stderr)
            raise

        yf_interval = _INTERVAL_MAP.get(interval, interval)
        yf_symbol = _normalize_yf(symbol)
        try:
            df = yf.Ticker(yf_symbol).history(start=start, end=end, interval=yf_interval, auto_adjust=True)
        except Exception as e:
            msg = str(e).lower()
            if "404" in msg or "delisted" in msg or "not found" in msg:
                print(f"__FINNY_FETCH_ERROR__: unknown_symbol: {yf_symbol}: {e}",
                      file=sys.stderr)
            elif "timeout" in msg or "connection" in msg or "network" in msg or "max retries" in msg:
                print(f"__FINNY_FETCH_ERROR__: network: {yf_symbol}: {e}", file=sys.stderr)
            else:
                print(f"__FINNY_FETCH_ERROR__: internal: {yf_symbol}: {e}", file=sys.stderr)
            raise

        if df is None or df.empty:
            print(f"__FINNY_FETCH_ERROR__: empty_window: {yf_symbol}: "
                  f"no bars between {start} and {end} at {yf_interval}", file=sys.stderr)
            raise RuntimeError("empty_window")

        df = df.reset_index()
        rename: Dict[str, str] = {}
        for col in df.columns:
            lc = col.strip().lower() if isinstance(col, str) else str(col).lower()
            if lc in ("date", "datetime"):
                rename[col] = "timestamp"
            elif lc in ("open", "high", "low", "close", "volume"):
                rename[col] = lc
        df = df.rename(columns=rename)
        if "timestamp" not in df.columns:
            df = df.rename(columns={df.columns[0]: "timestamp"})
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        df = df[["timestamp", "open", "high", "low", "close", "volume"]].astype(
            {"open": "float64", "high": "float64", "low": "float64",
             "close": "float64", "volume": "float64"}
        )
        return df
