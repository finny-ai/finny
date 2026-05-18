"""Binance public klines adapter — no API key required for historical OHLCV."""

from __future__ import annotations

import sys
import time
from typing import Dict, List

import pandas as pd

_SUPPORTED = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}

_INTERVAL_MAP: Dict[str, str] = {
    "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m",
    "1h": "1h", "4h": "4h", "1d": "1d",
}

_QUOTE_STRIP = {"USD", "USDT", "USDC", "BUSD"}

_MAX_KLINES_PER_REQUEST = 1000


def _to_binance_symbol(symbol: str) -> str:
    """'BTC/USD' or 'BTC/USDT' → 'BTCUSDT'. Bare 'BTC' → 'BTCUSDT'."""
    s = symbol.strip().upper()
    if "/" in s:
        base, quote = s.split("/", 1)
        if quote in _QUOTE_STRIP:
            return f"{base}USDT"
        return f"{base}{quote}"
    if "-" in s:
        base, quote = s.split("-", 1)
        if quote in _QUOTE_STRIP:
            return f"{base}USDT"
        return f"{base}{quote}"
    return f"{s}USDT"


def _fetch_klines_page(
    session, symbol: str, interval: str, start_ms: int, end_ms: int, limit: int = _MAX_KLINES_PER_REQUEST
) -> List[list]:
    url = "https://api.binance.com/api/v3/klines"
    params = {
        "symbol": symbol,
        "interval": interval,
        "startTime": start_ms,
        "endTime": end_ms,
        "limit": limit,
    }
    resp = session.get(url, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


class BinanceProvider:
    name = "binance"

    def supports_interval(self, interval: str) -> bool:
        return interval in _SUPPORTED or interval in _INTERVAL_MAP

    def fetch(self, symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
        try:
            import requests
        except ImportError as e:
            print(f"__FINNY_FETCH_ERROR__: python_env: requests import failed: {e}",
                  file=sys.stderr)
            raise

        bi_interval = _INTERVAL_MAP.get(interval, interval)
        bi_symbol = _to_binance_symbol(symbol)

        start_ms = int(pd.Timestamp(start, tz="UTC").timestamp() * 1000)
        end_ms = int(pd.Timestamp(end, tz="UTC").timestamp() * 1000)

        all_klines: List[list] = []
        cursor = start_ms
        session = requests.Session()

        try:
            while cursor < end_ms:
                klines = _fetch_klines_page(session, bi_symbol, bi_interval, cursor, end_ms)
                if not klines:
                    break
                all_klines.extend(klines)
                last_open_time = klines[-1][0]
                cursor = last_open_time + 1
                if len(klines) < _MAX_KLINES_PER_REQUEST:
                    break
                time.sleep(0.1)
        except Exception as e:
            msg = str(e).lower()
            if "400" in msg or "invalid symbol" in msg:
                print(f"__FINNY_FETCH_ERROR__: unknown_symbol: {bi_symbol}: {e}",
                      file=sys.stderr)
            elif "timeout" in msg or "connection" in msg:
                print(f"__FINNY_FETCH_ERROR__: network: {bi_symbol}: {e}",
                      file=sys.stderr)
            else:
                print(f"__FINNY_FETCH_ERROR__: internal: {bi_symbol}: {e}",
                      file=sys.stderr)
            raise
        finally:
            session.close()

        if not all_klines:
            print(f"__FINNY_FETCH_ERROR__: empty_window: {bi_symbol}: "
                  f"no bars between {start} and {end} at {bi_interval}", file=sys.stderr)
            raise RuntimeError("empty_window")

        rows = []
        for k in all_klines:
            rows.append({
                "timestamp": pd.Timestamp(k[0], unit="ms", tz="UTC"),
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "volume": float(k[5]),
            })

        df = pd.DataFrame(rows)
        df = df[["timestamp", "open", "high", "low", "close", "volume"]].astype(
            {"open": "float64", "high": "float64", "low": "float64",
             "close": "float64", "volume": "float64"}
        )
        return df
