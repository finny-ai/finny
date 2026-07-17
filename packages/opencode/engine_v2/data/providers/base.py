"""DataProvider Protocol — pluggable market-data backend.

Every provider returns a tidy DataFrame with columns
['timestamp','open','high','low','close','volume'] in UTC. Symbols are in
canonical form (e.g. 'ETH/USD', 'AAPL'); providers translate to their own
naming internally.
"""

from __future__ import annotations

import re
from typing import Protocol

import pandas as pd

_DATE_ONLY_RE = re.compile(r"^\s*\d{4}-\d{2}-\d{2}\s*$")


def fetch_end_bound_utc(end: str) -> pd.Timestamp:
    """Exclusive UTC upper bound for a fetch window's ``end``.

    A date-only ``end`` means the whole calendar day, inclusive — the engine's
    date filter and the strict end-coverage gate both treat it that way — so it
    resolves to midnight of the *following* day. Parsing it as midnight of the
    end day itself silently drops the end day's bars (exchange bars are stamped
    after midnight UTC), and strict runs then block on "last bar is before
    requested end" for any window ending on the last completed session.

    Date-only ends are capped at the current UTC midnight so a window ending
    today or later never pulls the still-forming current-day bar into a strict
    backtest. Explicit timestamps are preserved as-is — an intraday timestamp
    on the current day legitimately refers to already completed bars.
    """
    ts = pd.to_datetime(end, utc=True)
    if _DATE_ONLY_RE.match(end):
        ts = min(ts + pd.Timedelta(days=1), pd.Timestamp.now(tz="UTC").normalize())
    return ts


class DataProvider(Protocol):
    name: str

    def fetch(self, symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
        ...

    def supports_interval(self, interval: str) -> bool:
        ...
