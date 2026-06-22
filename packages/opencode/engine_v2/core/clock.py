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


def _calendar_session_minutes(calendar: str) -> float | None:
    return {
        "US_EQUITIES": 6.5 * 60.0,
        "US_OPTIONS": 6.5 * 60.0,
        "US_FUTURES": 23.0 * 60.0,
    }.get(calendar.upper())


def _interval_minutes(normalized: str) -> float | None:
    if normalized.endswith("m"):
        return float(int(normalized[:-1]))
    if normalized.endswith("h"):
        return float(int(normalized[:-1]) * 60)
    return None


def _interval_day_span(normalized: str) -> float:
    return float(int(normalized[:-1])) if normalized.endswith("d") else 1.0


def _session_calendar_bars_per_year(normalized: str, session_minutes: float) -> float:
    minutes = _interval_minutes(normalized)
    if minutes is not None:
        return _intraday_bars_per_year(minutes, session_minutes, 252.0)
    return _daily_bars_per_year(_interval_day_span(normalized), 252.0)


def _calendar_bars_per_year_for_calendar(interval: str, calendar: str, bars_per_day: float) -> float:
    session_minutes = _calendar_session_minutes(calendar)
    normalized = _normalize_interval(interval)
    if session_minutes is not None:
        return _session_calendar_bars_per_year(normalized, session_minutes)
    if calendar.upper() == "FX_24_5":
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
