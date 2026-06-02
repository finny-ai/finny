"""Alpaca market-data adapter for historical OHLCV bars.

Uses credentials from environment variables populated by the TypeScript caller:
ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY. The default stock feed is IEX so
paper accounts can use the free market-data plan; set ALPACA_DATA_FEED=sip when
the account has SIP access.
"""

from __future__ import annotations

import os
import sys
import re
from typing import Dict, List, Optional

import pandas as pd

_SUPPORTED = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}

_TIMEFRAME_MAP: Dict[str, str] = {
    "1min": "1Min",
    "1m": "1Min",
    "5min": "5Min",
    "5m": "5Min",
    "15min": "15Min",
    "15m": "15Min",
    "30min": "30Min",
    "30m": "30Min",
    "1h": "1Hour",
    "4h": "4Hour",
    "1d": "1Day",
}

_DATA_BASE = "https://data.alpaca.markets"
_OPTION_RE = re.compile(
    r"^([A-Z]{1,6})/(\d{8})/(\d+(?:\.\d+)?)([CP])$", re.IGNORECASE
)


def _headers() -> Optional[Dict[str, str]]:
    key = os.environ.get("ALPACA_API_KEY_ID")
    secret = os.environ.get("ALPACA_API_SECRET_KEY")
    if not key or not secret:
        return None
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
    }


def _is_equity_symbol(symbol: str) -> bool:
    return "/" not in symbol and "-" not in symbol and symbol.strip().isalpha()


def _to_alpaca_option_symbol(symbol: str) -> Optional[str]:
    """Convert Finny canonical option symbol to Alpaca/OCC format.

    SPY/20260619/500C -> SPY260619C00500000
    """
    m = _OPTION_RE.match(symbol.strip().upper())
    if not m:
        return None
    underlying, expiry, strike, right = m.groups()
    strike_milli = int(round(float(strike) * 1000))
    return f"{underlying}{expiry[2:]}{right.upper()}{strike_milli:08d}"


class AlpacaProvider:
    name = "alpaca"

    def supports_interval(self, interval: str) -> bool:
        return interval in _SUPPORTED or interval in _TIMEFRAME_MAP

    def fetch(self, symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
        try:
            import requests
        except ImportError as e:
            print(f"__FINNY_FETCH_ERROR__: python_env: requests import failed: {e}",
                  file=sys.stderr)
            raise

        headers = _headers()
        if headers is None:
            raise RuntimeError("missing Alpaca credentials")

        timeframe = _TIMEFRAME_MAP.get(interval, interval)
        feed = os.environ.get("ALPACA_DATA_FEED", "iex")
        sym = symbol.strip().upper()
        option_sym = _to_alpaca_option_symbol(sym)
        is_option = option_sym is not None
        if not is_option and not _is_equity_symbol(sym):
            raise RuntimeError("alpaca provider currently supports equities and options only")
        request_sym = option_sym or sym

        rows: List[dict] = []
        page_token: Optional[str] = None
        session = requests.Session()
        try:
            while True:
                params = {
                    "symbols": request_sym,
                    "timeframe": timeframe,
                    "start": pd.Timestamp(start, tz="UTC").isoformat(),
                    "end": pd.Timestamp(end, tz="UTC").isoformat(),
                    "limit": 10000,
                }
                if is_option:
                    url = f"{_DATA_BASE}/v1beta1/options/bars"
                else:
                    url = f"{_DATA_BASE}/v2/stocks/bars"
                    params["adjustment"] = "raw"
                    params["feed"] = feed
                if page_token:
                    params["page_token"] = page_token

                resp = session.get(url, params=params, headers=headers, timeout=30)
                resp.raise_for_status()
                payload = resp.json()
                bars_by_symbol = payload.get("bars") or {}
                if isinstance(bars_by_symbol, list):
                    bars = bars_by_symbol
                else:
                    bars = bars_by_symbol.get(request_sym) or []
                    if not bars and len(bars_by_symbol) == 1:
                        bars = next(iter(bars_by_symbol.values()))
                rows.extend(bars)
                page_token = payload.get("next_page_token")
                if not page_token:
                    break
        except Exception as e:
            msg = str(e).lower()
            if "401" in msg or "403" in msg or "unauthorized" in msg or "forbidden" in msg:
                print(f"__FINNY_FETCH_ERROR__: auth: {request_sym}: {e}", file=sys.stderr)
            elif "404" in msg or "not found" in msg:
                print(f"__FINNY_FETCH_ERROR__: unknown_symbol: {request_sym}: {e}",
                      file=sys.stderr)
            elif "timeout" in msg or "connection" in msg or "network" in msg or "max retries" in msg:
                print(f"__FINNY_FETCH_ERROR__: network: {request_sym}: {e}", file=sys.stderr)
            else:
                print(f"__FINNY_FETCH_ERROR__: internal: {request_sym}: {e}", file=sys.stderr)
            raise
        finally:
            session.close()

        if not rows:
            print(f"__FINNY_FETCH_ERROR__: empty_window: {request_sym}: "
                  f"no bars between {start} and {end} at {timeframe}", file=sys.stderr)
            raise RuntimeError("empty_window")

        df = pd.DataFrame([{
            "timestamp": pd.to_datetime(r["t"], utc=True),
            "open": float(r["o"]),
            "high": float(r["h"]),
            "low": float(r["l"]),
            "close": float(r["c"]),
            "volume": float(r.get("v", 0.0)),
        } for r in rows])

        df = df[["timestamp", "open", "high", "low", "close", "volume"]].astype(
            {"open": "float64", "high": "float64", "low": "float64",
             "close": "float64", "volume": "float64"}
        )
        return df
