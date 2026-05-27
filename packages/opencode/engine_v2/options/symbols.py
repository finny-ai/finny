"""Option symbol parsing and construction.

Canonical format: UNDERLYING/YYYYMMDD/STRIKE[C|P]
Examples: SPY/20260619/500C, AAPL/20260117/175.5P
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_OPTION_RE = re.compile(
    r"^([A-Z]{1,6})/(\d{8})/(\d+(?:\.\d+)?)([CP])$", re.IGNORECASE
)


@dataclass(frozen=True)
class OptionSpec:
    underlying: str
    expiry: str      # YYYYMMDD
    strike: float
    right: str       # "C" or "P"

    @property
    def is_call(self) -> bool:
        return self.right == "C"

    @property
    def is_put(self) -> bool:
        return self.right == "P"


def is_option_symbol(symbol: str) -> bool:
    return _OPTION_RE.match(symbol.strip()) is not None


def parse_option_symbol(symbol: str) -> OptionSpec:
    m = _OPTION_RE.match(symbol.strip())
    if m is None:
        raise ValueError(f"invalid option symbol: {symbol!r}")
    underlying, expiry, strike_str, right = m.groups()
    return OptionSpec(
        underlying=underlying.upper(),
        expiry=expiry,
        strike=float(strike_str),
        right=right.upper(),
    )


def make_option_symbol(underlying: str, expiry: str, strike: float, right: str) -> str:
    if right.upper() not in ("C", "P"):
        raise ValueError(f"right must be 'C' or 'P', got {right!r}")
    if len(expiry) != 8 or not expiry.isdigit():
        raise ValueError(f"expiry must be YYYYMMDD, got {expiry!r}")
    strike_str = f"{strike:g}"
    return f"{underlying.upper()}/{expiry}/{strike_str}{right.upper()}"
