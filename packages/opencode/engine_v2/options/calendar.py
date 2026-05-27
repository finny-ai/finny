"""US equity options calendar — trading days and time-to-expiry."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Union

# Fixed NYSE holidays (month, day). New Year's, Independence Day, Christmas.
_FIXED_HOLIDAYS_MD = {(1, 1), (7, 4), (12, 25)}

# NYSE holidays that fall on specific weekday-of-month patterns.
# (month, weekday, occurrence)  weekday: 0=Mon
_FLOATING_HOLIDAYS = [
    (1, 0, 3),   # MLK Day: 3rd Monday of January
    (2, 0, 3),   # Presidents' Day: 3rd Monday of February
    (5, 0, -1),  # Memorial Day: last Monday of May
    (6, 2, 3),   # Juneteenth: June 19 (approximated as 3rd Wed — handled separately)
    (9, 0, 1),   # Labor Day: 1st Monday of September
    (11, 3, 4),  # Thanksgiving: 4th Thursday of November
]


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    if n > 0:
        first = date(year, month, 1)
        offset = (weekday - first.weekday()) % 7
        d = first + timedelta(days=offset + 7 * (n - 1))
        return d
    # Last occurrence
    if month == 12:
        last = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        last = date(year, month + 1, 1) - timedelta(days=1)
    offset = (last.weekday() - weekday) % 7
    return last - timedelta(days=offset)


def _holidays_for_year(year: int) -> set[date]:
    holidays: set[date] = set()
    for m, d in _FIXED_HOLIDAYS_MD:
        holidays.add(date(year, m, d))
    # Juneteenth is a fixed date: June 19
    holidays.add(date(year, 6, 19))
    for m, wd, n in _FLOATING_HOLIDAYS:
        if m == 6:
            continue  # Juneteenth handled above
        holidays.add(_nth_weekday(year, m, wd, n))
    # Good Friday — 2 days before Easter Sunday
    holidays.add(_easter(year) - timedelta(days=2))
    return holidays


def _easter(year: int) -> date:
    """Anonymous Gregorian algorithm for Easter Sunday."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def is_trading_day(d: date) -> bool:
    if d.weekday() >= 5:
        return False
    return d not in _holidays_for_year(d.year)


def trading_days_between(start: date, end: date) -> int:
    if end <= start:
        return 0
    count = 0
    d = start + timedelta(days=1)
    while d <= end:
        if is_trading_day(d):
            count += 1
        d += timedelta(days=1)
    return count


def time_to_expiry_years(
    expiry: str,
    as_of: Union[date, datetime, int, float],
    use_trading_days: bool = True,
) -> float:
    exp_date = date(int(expiry[:4]), int(expiry[4:6]), int(expiry[6:8]))

    if isinstance(as_of, (int, float)):
        # Unix nanoseconds or seconds
        ts = as_of / 1e9 if as_of > 1e15 else float(as_of)
        as_of_date = datetime.fromtimestamp(ts, tz=timezone.utc).date()
    elif isinstance(as_of, datetime):
        as_of_date = as_of.date()
    else:
        as_of_date = as_of

    if use_trading_days:
        td = trading_days_between(as_of_date, exp_date)
        return td / 252.0
    else:
        delta = (exp_date - as_of_date).days
        return max(delta, 0) / 365.0
