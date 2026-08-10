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

import numpy as np
import pandas as pd

from .base import fetch_end_bound_utc
from ...assets import resolve_asset_spec
from ..calendars import ExpectedTimestampRequest, expected_timestamps, is_nyse_half_day
from ...options.calendar import is_trading_day
from ..quality import expected_step

_SUPPORTED = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}

# Alpaca stamps hourly bars on wall-clock grids (top of the hour, including
# the 08:00 ET pre-market and 16:00 ET post-close bars on IEX), while strict
# qualification expects bars on the Finny regular-session grid (09:30, 10:30,
# ... ET). Only intervals whose wall-clock grid genuinely misaligns with the
# 09:30-anchored session (1h, 4h) are reconstructed from 1m bars. Native
# 1m/5m/15m/30m bars already land on the session grid, so granular
# reconstruction there would only multiply download size (and risk the
# provider timeout) without fixing alignment. Values match _TIMEFRAME_MAP's
# pandas-style timeframe names.
_GRANULAR_SESSION_INTERVALS = {"1Hour", "4Hour"}

# Regional listings (XNSE, XTSE, ...) are provider-observed by the strict
# engine because their exchange calendars are not implemented; their native
# timestamps must be preserved.
_SESSION_GRID_CALENDARS = {"US_EQUITIES", "XNYS"}

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


def _session_aggregate(
    df: pd.DataFrame,
    symbol: str,
    start: str,
    end: str,
    interval: str,
) -> pd.DataFrame:
    """Re-bin 1m bars onto the exact expected XNYS session grid.

    Bars are bucketed into [expected_ts, expected_ts + interval) for every
    timestamp the strict calendar expects (09:30-anchored, regular session
    only). Extended-hours bars and bars that fall outside the grid are
    dropped, and each bucket aggregates open=first / high=max / low=min /
    close=last / volume=sum, deterministically.

    The grid is generated with the same requested bounds the caller passes to
    ``fetch``, so the returned timestamps are exactly the ones the strict
    coverage gate validates against. A bucket is only emitted when its
    session-truncated close (bin start + interval, or the exchange close on
    half days) is at or before the exclusive fetch bound: a trailing bucket
    cut short by an explicit timestamp end is omitted so strict coverage
    fails closed instead of presenting a partial bar as complete.
    """
    asset_spec = resolve_asset_spec({"symbol": symbol, "asset_class": "equity"})
    if str(asset_spec.calendar).upper() not in _SESSION_GRID_CALENDARS:
        return df
    step = expected_step(interval)
    raw_end = pd.to_datetime(end, utc=True)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", end):
        exclusive_end = fetch_end_bound_utc(end)
    else:
        # Explicit timestamps are the caller's exclusive bound; the runner
        # shaves one second off its completed-window cap, so restore it.
        exclusive_end = raw_end + pd.Timedelta(seconds=1)
    expected = expected_timestamps(
        ExpectedTimestampRequest(
            requested_start=start,
            requested_end=end,
            interval=interval,
            asset_class="equity",
            calendar_id=asset_spec.calendar,
        )
    )
    if len(expected) == 0:
        return df.iloc[0:0]
    if df.empty:
        return df

    frame = df.sort_values("timestamp").reset_index(drop=True)
    ts = pd.DatetimeIndex(pd.to_datetime(frame["timestamp"], utc=True))
    # Duplicate raw timestamps must not be silently merged: identical rows
    # are deduped, conflicting rows fail closed (merging would hide the
    # anomaly and double-count volume past the downstream duplicate gate).
    dup_mask = ts.duplicated(keep=False)
    if dup_mask.any():
        dup_agg = frame.loc[dup_mask].groupby(ts[dup_mask], sort=False).nunique(dropna=False)
        conflicting = dup_agg[dup_agg.gt(1).any(axis=1)]
        if len(conflicting):
            samples = [value.isoformat() for value in conflicting.index[:3]]
            raise RuntimeError(
                f"alpaca returned conflicting duplicate bars at {samples}"
            )
        frame = frame.loc[~ts.duplicated(keep="first")].reset_index(drop=True)
        ts = pd.DatetimeIndex(pd.to_datetime(frame["timestamp"], utc=True))

    pos = expected.searchsorted(ts, side="right") - 1
    bin_start = expected[pos.clip(min=0)]
    # The final bucket of each session is partial-width (e.g. 15:30-16:00 ET
    # for a 1h grid), so bars must also fall inside the regular session:
    # after-hours bars stamped after the exchange close belong to no bucket.
    local = ts.tz_convert("America/New_York")
    minutes = local.hour * 60 + local.minute
    day_close = np.array(
        [
            13 * 60 if is_nyse_half_day(day) else 16 * 60
            for day in local.date
        ]
    )
    in_session = (
        np.array([is_trading_day(day) for day in local.date])
        & (minutes >= 9 * 60 + 30)
        & (minutes < day_close)
    )
    # Completeness: a bucket is valid only if its session-truncated close is
    # covered by the exclusive fetch bound. Omitted buckets then surface as
    # missing timestamps in the strict coverage gate. Computed once per grid
    # timestamp, then mapped per bar through its bin position.
    grid_day = expected.tz_convert("America/New_York").date
    grid_close_utc = pd.DatetimeIndex(
        [
            pd.Timestamp(day.year, day.month, day.day, 13 if is_nyse_half_day(day) else 16, 0, tz="America/New_York").tz_convert("UTC")
            for day in grid_day
        ]
    )
    # min(bin_close, session_close) <= exclusive_end  <=>  either bound is
    # covered; avoids numpy tz-naive comparisons.
    bin_complete = ((expected + step) <= exclusive_end) | (grid_close_utc <= exclusive_end)
    complete = bin_complete[pos.clip(min=0)]
    valid = (
        (pos >= 0)
        & (ts >= bin_start)
        & (ts < bin_start + step)
        & in_session
        & complete
    )
    frame = frame.loc[valid].copy()
    if frame.empty:
        return frame[["timestamp", "open", "high", "low", "close", "volume"]]

    frame["_bin"] = expected[pos[valid]]
    aggregated = (
        frame.groupby("_bin", sort=True)
        .agg(
            open=("open", "first"),
            high=("high", "max"),
            low=("low", "min"),
            close=("close", "last"),
            volume=("volume", "sum"),
        )
        .reset_index()
        .rename(columns={"_bin": "timestamp"})
    )
    return aggregated[["timestamp", "open", "high", "low", "close", "volume"]]


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

        # US equity intraday: fetch 1m bars and re-bin onto the strict session
        # grid (see _session_aggregate). Options and daily bars keep the
        # provider's native timestamps.
        granular_session = (
            not is_option
            and _TIMEFRAME_MAP.get(interval, interval) in _GRANULAR_SESSION_INTERVALS
        )
        if granular_session:
            timeframe = "1Min"

        # Alpaca's `end` filter is inclusive of the instant; back off a
        # microsecond from the exclusive bound so a date-only end covers its
        # full calendar day without touching the next one.
        api_end = fetch_end_bound_utc(end) - pd.Timedelta(microseconds=1)

        rows: List[dict] = []
        page_token: Optional[str] = None
        session = requests.Session()
        try:
            while True:
                params = {
                    "symbols": request_sym,
                    "timeframe": timeframe,
                    "start": pd.Timestamp(start, tz="UTC").isoformat(),
                    "end": api_end.isoformat(),
                    "limit": 10000,
                }
                if is_option:
                    url = f"{_DATA_BASE}/v1beta1/options/bars"
                else:
                    url = f"{_DATA_BASE}/v2/stocks/bars"
                    params["adjustment"] = "all"
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
        if granular_session:
            df = _session_aggregate(df, sym, start, end, interval)
        return df
