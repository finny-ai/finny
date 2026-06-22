"""Interval parsing + bars-per-year. Ported from backtest.py:241."""

from __future__ import annotations

from typing import Tuple


def interval_to_rule_and_bars_per_year(interval: str) -> Tuple[str, float]:
    s = interval.strip().lower()
    if s.endswith("mins"):
        s = s[:-4] + "m"
    elif s.endswith("min"):
        s = s[:-3] + "m"
    if s.endswith("m"):
        n = int(s[:-1])
        if n <= 0:
            raise ValueError(f"Unsupported interval: {interval}")
        return f"{n}min", (60.0 / n) * 24.0 * 365.0
    if s.endswith("h"):
        n = int(s[:-1])
        if n <= 0:
            raise ValueError(f"Unsupported interval: {interval}")
        return f"{n}h", (24.0 / n) * 365.0
    if s.endswith("d"):
        n = int(s[:-1])
        if n <= 0:
            raise ValueError(f"Unsupported interval: {interval}")
        return f"{n}D", 365.0 / n
    raise ValueError(f"Unsupported interval: {interval}")


def calendar_bars_per_year(interval: str, calendar: str) -> float:
    """Annualization from asset calendar and interval.

    Intraday 24/7 assets use 365 calendar days. US equities/options use regular
    6.5 hour sessions and 252 trading days. Listed futures use a conservative
    23 hour, 252 session-year approximation; FX uses 24x5.
    """
    s = interval.strip().lower()
    if s.endswith("mins"):
        s = s[:-4] + "m"
    elif s.endswith("min"):
        s = s[:-3] + "m"
    if s.endswith("m"):
        minutes = int(s[:-1])
        bars_per_day = 24.0 * 60.0 / minutes
    elif s.endswith("h"):
        hours = int(s[:-1])
        bars_per_day = 24.0 / hours
    elif s.endswith("d"):
        days = int(s[:-1])
        bars_per_day = 1.0 / days
    else:
        raise ValueError(f"Unsupported interval: {interval}")

    cal = calendar.upper()
    if cal in {"US_EQUITIES", "US_OPTIONS"}:
        if s.endswith(("m", "h")):
            return (6.5 * 60.0 / (minutes if s.endswith("m") else hours * 60.0)) * 252.0
        return 252.0 / (days if s.endswith("d") else 1.0)
    if cal == "US_FUTURES":
        if s.endswith(("m", "h")):
            return (23.0 * 60.0 / (minutes if s.endswith("m") else hours * 60.0)) * 252.0
        return 252.0 / (days if s.endswith("d") else 1.0)
    if cal == "FX_24_5":
        return bars_per_day * 260.0
    return bars_per_day * 365.0


def bars_per_day(interval: str) -> float:
    _, bpy = interval_to_rule_and_bars_per_year(interval)
    return bpy / 365.0
