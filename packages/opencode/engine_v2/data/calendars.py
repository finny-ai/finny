"""Deterministic timestamp calendars for strict dataset qualification.

The strict path deliberately owns a small, versioned policy surface instead of
inferring expected bars from the rows a provider happened to return.  Calendar
IDs are explicit and unsupported combinations fail closed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

from ..options.calendar import is_trading_day


CALENDAR_VERSION = "finny-calendars-2026.1"
NEW_YORK = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class CalendarPolicy:
    calendar_id: str
    session_type: str
    timezone: str
    half_day_policy: str = "scheduled_early_close"


@dataclass(frozen=True)
class ExpectedTimestampRequest:
    requested_start: str
    requested_end: str
    interval: str
    asset_class: str
    calendar_id: str | None = None
    session_type: str | None = None


_ASSET_POLICIES = {
    "equity": ("XNYS", "regular", "America/New_York", "scheduled_early_close"),
    "option": ("XNYS", "regular", "America/New_York", "scheduled_early_close"),
    "future": ("CMES", "overnight", "America/New_York", "scheduled_early_close"),
    "crypto": ("24/7", "continuous", "UTC", "not_applicable"),
    "crypto_spot": ("24/7", "continuous", "UTC", "not_applicable"),
    "crypto_perp": ("24/7", "continuous", "UTC", "not_applicable"),
    "fx": ("FX_24_5", "continuous", "America/New_York", "not_applicable"),
}

_CALENDAR_ALIASES = {
    # AssetSpec historically uses these product-facing names while strict
    # evidence uses exchange MICs. They describe the same regular session.
    "US_EQUITIES": "XNYS",
    "US_OPTIONS": "XNYS",
}


def default_calendar_policy(asset_class: str, session_type: str | None = None) -> CalendarPolicy:
    asset = asset_class.strip().lower()
    configured = _ASSET_POLICIES.get(asset)
    if configured is None:
        raise ValueError(f"no strict calendar policy for asset class: {asset_class}")
    calendar_id, default_session, timezone, half_day_policy = configured
    session = session_type or default_session
    if calendar_id == "XNYS" and session not in {"regular", "extended"}:
        raise ValueError(f"unsupported US equity session type: {session}")
    return CalendarPolicy(calendar_id, session, timezone, half_day_policy)


def _thanksgiving(year: int) -> date:
    day = date(year, 11, 1)
    return day + timedelta(days=(3 - day.weekday()) % 7 + 21)


def is_nyse_half_day(day: date) -> bool:
    """Scheduled 13:00 ET closes covered by the versioned XNYS policy."""
    if not is_trading_day(day):
        return False
    fixed_half_days = {
        _thanksgiving(day.year) + timedelta(days=1),
        date(day.year, 12, 24),
        date(day.year, 7, 3),
    }
    # July 3 is an early close when it is itself a trading day and July 4 is
    # observed on July 4.  When July 4 falls on Sunday, July 2 is the early close.
    sunday_observance_half_day = date(day.year, 7, 2)
    return day in fixed_half_days or (
        day == sunday_observance_half_day and date(day.year, 7, 4).weekday() == 6
    )


def _utc(value: str | pd.Timestamp) -> pd.Timestamp:
    return pd.to_datetime(value, utc=True)


def _date_bounds(requested_start: str, requested_end: str) -> tuple[date, date]:
    start = _utc(requested_start).date()
    end = _utc(requested_end).date()
    if end < start:
        raise ValueError("requested_end must be on or after requested_start")
    return start, end


def _days(start: date, end: date):
    cursor = start
    while cursor <= end:
        yield cursor
        cursor += timedelta(days=1)


def _session_range(start: pd.Timestamp, end: pd.Timestamp, step: pd.Timedelta) -> list[pd.Timestamp]:
    if end <= start:
        return []
    # Bar timestamps identify interval starts. Keep every start strictly before
    # the session close, including a final partial-width bucket such as the
    # 15:30-16:00 ET bar in a regular NYSE 1h session.
    return list(pd.date_range(start, end, freq=step, inclusive="left"))


def _nyse_expected(start: date, end: date, step: pd.Timedelta, session_type: str) -> list[pd.Timestamp]:
    daily = step >= pd.Timedelta(days=1)
    expected: list[pd.Timestamp] = []
    for day in _days(start, end):
        if not is_trading_day(day):
            continue
        if daily:
            expected.append(pd.Timestamp(day, tz="UTC"))
            continue
        open_time = (4, 0) if session_type == "extended" else (9, 30)
        close_time = (20, 0) if session_type == "extended" else ((13, 0) if is_nyse_half_day(day) else (16, 0))
        local_open = pd.Timestamp(day.year, day.month, day.day, *open_time, tz=NEW_YORK)
        local_close = pd.Timestamp(day.year, day.month, day.day, *close_time, tz=NEW_YORK)
        expected.extend(_session_range(local_open.tz_convert("UTC"), local_close.tz_convert("UTC"), step))
    return expected


def _continuous_expected(start: date, end: date, step: pd.Timedelta) -> list[pd.Timestamp]:
    first = pd.Timestamp(start, tz="UTC")
    exclusive = pd.Timestamp(end + timedelta(days=1), tz="UTC")
    return _session_range(first, exclusive, step)


def _fx_expected(start: date, end: date, step: pd.Timedelta) -> list[pd.Timestamp]:
    # Retail FX is modeled from Sunday 17:00 ET through Friday 17:00 ET.
    expected: list[pd.Timestamp] = []
    for timestamp in _continuous_expected(start, end, step):
        local = timestamp.tz_convert(NEW_YORK)
        weekday, clock = local.weekday(), local.time()
        open_market = weekday < 4 or (weekday == 4 and clock < pd.Timestamp("17:00").time())
        open_market = open_market or (weekday == 6 and clock >= pd.Timestamp("17:00").time())
        if open_market:
            expected.append(timestamp)
    return expected


def _futures_expected(start: date, end: date, step: pd.Timedelta) -> list[pd.Timestamp]:
    # CMES policy: each Mon-Fri trade date has a 23-hour session beginning at
    # 18:00 ET on the previous calendar day and ending at 17:00 ET.
    if step >= pd.Timedelta(days=1):
        return [pd.Timestamp(day, tz="UTC") for day in _days(start, end) if day.weekday() < 5]
    expected: list[pd.Timestamp] = []
    for trade_day in _days(start, end):
        if trade_day.weekday() >= 5:
            continue
        previous = trade_day - timedelta(days=1)
        session_open = pd.Timestamp(previous.year, previous.month, previous.day, 18, 0, tz=NEW_YORK)
        session_close = pd.Timestamp(trade_day.year, trade_day.month, trade_day.day, 17, 0, tz=NEW_YORK)
        expected.extend(_session_range(session_open.tz_convert("UTC"), session_close.tz_convert("UTC"), step))
    return expected


def expected_timestamps(request: ExpectedTimestampRequest) -> pd.DatetimeIndex:
    """Return the exact inclusive requested-window timestamp set."""
    from .quality import expected_step  # avoid a module import cycle

    policy = default_calendar_policy(request.asset_class, request.session_type)
    requested_calendar = _CALENDAR_ALIASES.get(request.calendar_id or "", request.calendar_id)
    if requested_calendar and requested_calendar != policy.calendar_id:
        raise ValueError(
            f"calendar {request.calendar_id!r} does not match strict policy {policy.calendar_id!r} "
            f"for {request.asset_class}"
        )
    start, end = _date_bounds(request.requested_start, request.requested_end)
    step = expected_step(request.interval)
    generators = {
        "XNYS": lambda: _nyse_expected(start, end, step, policy.session_type),
        "CMES": lambda: _futures_expected(start, end, step),
        "FX_24_5": lambda: _fx_expected(start, end, step),
        "24/7": lambda: _continuous_expected(start, end, step),
    }
    values = generators[policy.calendar_id]()
    expected = pd.DatetimeIndex(values, tz="UTC").drop_duplicates().sort_values()
    # Date-only requests intentionally mean complete calendar/session days.
    # Qualification phase windows, however, are immutable bar-level timestamps
    # and commonly split a continuous day. Preserve those exact inclusive
    # boundaries instead of expanding them back to midnight-to-midnight.
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", request.requested_start):
        expected = expected[expected >= _utc(request.requested_start)]
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", request.requested_end):
        expected = expected[expected <= _utc(request.requested_end)]
    return expected


def requested_input_start(request: ExpectedTimestampRequest) -> pd.Timestamp:
    """Earliest provider timestamp needed to evaluate the requested trade-date window."""
    expected = expected_timestamps(
        ExpectedTimestampRequest(
            requested_start=request.requested_start,
            requested_end=request.requested_start,
            interval=request.interval,
            asset_class=request.asset_class,
            calendar_id=request.calendar_id,
            session_type=request.session_type,
        )
    )
    return expected.min() if len(expected) else _utc(request.requested_start)
