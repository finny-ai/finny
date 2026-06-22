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


def _normalize_interval(interval: str) -> str:
    s = interval.strip().lower()
    if s.endswith("mins"):
        return s[:-4] + "m"
    if s.endswith("min"):
        return s[:-3] + "m"
    return s


def _intraday_bars_per_year(minutes: float, session_minutes: float, trading_days: float) -> float:
    return (session_minutes / minutes) * trading_days


def _daily_bars_per_year(day_span: float, trading_days: float) -> float:
    return trading_days / day_span


def _calendar_bars_per_year_for_calendar(interval: str, calendar: str, bars_per_day: float) -> float:
    cal = calendar.upper()
    s = _normalize_interval(interval)
    if cal in {"US_EQUITIES", "US_OPTIONS"}:
        if s.endswith(("m", "h")):
            minutes = int(s[:-1]) if s.endswith("m") else int(s[:-1]) * 60
            return _intraday_bars_per_year(minutes, 6.5 * 60.0, 252.0)
        days = int(s[:-1]) if s.endswith("d") else 1
        return _daily_bars_per_year(days, 252.0)
    if cal == "US_FUTURES":
        if s.endswith(("m", "h")):
            minutes = int(s[:-1]) if s.endswith("m") else int(s[:-1]) * 60
            return _intraday_bars_per_year(minutes, 23.0 * 60.0, 252.0)
        days = int(s[:-1]) if s.endswith("d") else 1
        return _daily_bars_per_year(days, 252.0)
    if cal == "FX_24_5":
        return bars_per_day * 260.0
    return bars_per_day * 365.0


def calendar_bars_per_year(interval: str, calendar: str) -> float:
    """Annualization from asset calendar and interval.

    Intraday 24/7 assets use 365 calendar days. US equities/options use regular
    6.5 hour sessions and 252 trading days. Listed futures use a conservative
    23 hour, 252 session-year approximation; FX uses 24x5.
    """
    s = _normalize_interval(interval)
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

    return _calendar_bars_per_year_for_calendar(interval, calendar, bars_per_day)


def bars_per_day(interval: str) -> float:
    _, bpy = interval_to_rule_and_bars_per_year(interval)
    return bpy / 365.0
