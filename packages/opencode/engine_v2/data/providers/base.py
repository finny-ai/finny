"""DataProvider Protocol — pluggable market-data backend.

Every provider returns a tidy DataFrame with columns
['timestamp','open','high','low','close','volume'] in UTC. Symbols are in
canonical form (e.g. 'ETH/USD', 'AAPL'); providers translate to their own
naming internally.
"""

from __future__ import annotations

from typing import Protocol

import pandas as pd


class DataProvider(Protocol):
    name: str

    def fetch(self, symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
        ...

    def supports_interval(self, interval: str) -> bool:
        ...
