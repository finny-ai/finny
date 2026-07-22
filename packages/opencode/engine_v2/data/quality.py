"""Data-quality detectors and hard gates for strict backtests."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

from ..options.calendar import is_trading_day


@dataclass
class OutlierDetail:
    timestamp: str
    previous_close: float
    current_close: float
    log_return: float
    z_score: float
    provider: str = "unknown"


@dataclass
class QualityReport:
    n_bars: int
    coverage_pct: float
    gap_count: int
    duplicate_ts_count: int
    ohlc_violations: int
    outlier_bars: int
    zero_volume_bars: int
    notes: List[str] = field(default_factory=list)
    outlier_details: List[OutlierDetail] = field(default_factory=list)
    repaired_outliers: int = 0
    repair_applied: bool = False
    expected_timestamp_count: int = 0
    actual_timestamp_count: int = 0
    missing_timestamp_count: int = 0
    extra_timestamp_count: int = 0
    missing_timestamps: List[str] = field(default_factory=list)
    extra_timestamps: List[str] = field(default_factory=list)
    missing_ranges: List[Dict[str, object]] = field(default_factory=list)
    incomplete_final_bar_count: int = 0
    calendar_id: str | None = None
    calendar_version: str | None = None
    session_type: str | None = None


def expected_step(interval: str) -> pd.Timedelta:
    s = interval.strip().lower()
    if s.endswith("min") or s.endswith("m"):
        n = int(s.replace("min", "").replace("m", "") or "1")
        return pd.Timedelta(minutes=n)
    if s.endswith("h"):
        # Allow bare "h" → 1 hour, mirroring the minute branch.
        n = int(s[:-1]) if len(s) > 1 else 1
        return pd.Timedelta(hours=n)
    if s.endswith("d"):
        n = int(s[:-1]) if len(s) > 1 else 1
        return pd.Timedelta(days=n)
    return pd.Timedelta(minutes=1)


def is_intraday_interval(interval: str) -> bool:
    step = expected_step(interval)
    return step < pd.Timedelta(days=1)


def _continuous_return_mask(ts: pd.Series, interval: str, asset_class: str) -> np.ndarray:
    """Return a mask for close-to-close returns that are within one continuous session.

    Intraday equity data has overnight/weekend gaps by design. Treating the
    previous session close and next session open as adjacent bars makes normal
    gaps look like provider outliers, so outlier detection only scores returns
    whose timestamp spacing is close to the requested interval.
    """
    if len(ts) <= 1:
        return np.zeros(0, dtype=bool)
    diffs = ts.diff().iloc[1:]
    step = expected_step(interval)
    if asset_class in {"equity", "future", "option"} and is_intraday_interval(interval):
        return (diffs <= step * 1.5).to_numpy()
    if asset_class in {"crypto", "crypto_spot", "crypto_perp", "fx"}:
        return (diffs <= step * 1.5).to_numpy()
    return np.ones(len(ts) - 1, dtype=bool)


def _minimum_outlier_log_return(interval: str, asset_class: str) -> float:
    """Minimum absolute move before a z-score can become a hard outlier.

    A z-score-only detector is too brittle for quiet intraday equity samples:
    a plausible SPY 5-minute rally can be many standard deviations without
    being a provider defect. Keep strict mode focused on moves that are both
    statistically extreme and large enough to plausibly indicate bad data.
    """
    asset_group = _asset_group(asset_class)
    if not is_intraday_interval(interval):
        return {"equity": 0.20, "crypto": 0.35}.get(asset_group, 0.0)
    step = expected_step(interval)
    return _intraday_outlier_floor(step, asset_group)


def _asset_group(asset_class: str) -> str:
    if asset_class in {"equity", "future", "option"}:
        return "equity"
    if asset_class in {"crypto", "crypto_spot", "crypto_perp", "fx"}:
        return "crypto"
    return "other"


def _intraday_outlier_floor(step: pd.Timedelta, asset_group: str) -> float:
    by_group = {
        "equity": [(pd.Timedelta(minutes=5), 0.03), (pd.Timedelta(minutes=15), 0.04), (None, 0.05)],
        "crypto": [(pd.Timedelta(minutes=5), 0.08), (pd.Timedelta(minutes=15), 0.10), (None, 0.12)],
    }
    for limit, value in by_group.get(asset_group, []):
        if limit is None or step <= limit:
            return value
    return 0.0


def _exchange_session_bounds(day: pd.Timestamp, asset_class: str) -> Tuple[pd.Timestamp, pd.Timestamp] | None:
    if not is_trading_day(day.date()):
        return None
    if asset_class == "future":
        session_start = day
        session_end = day + pd.Timedelta(hours=23)
        return session_start, session_end
    local_day = day.tz_convert("America/New_York")
    session_start = pd.Timestamp(
        local_day.year, local_day.month, local_day.day, 9, 30,
        tz="America/New_York",
    ).tz_convert("UTC")
    session_end = pd.Timestamp(
        local_day.year, local_day.month, local_day.day, 16, 0,
        tz="America/New_York",
    ).tz_convert("UTC")
    if session_end <= session_start:
        return None
    return session_start, session_end


def _bars_in_session(session_start: pd.Timestamp, session_end: pd.Timestamp, step: pd.Timedelta) -> int:
    return max(0, int((session_end - session_start) / step))


def _exchange_expected_count(ts: pd.Series, interval: str, asset_class: str) -> int:
    if len(ts) <= 1 or asset_class not in {"equity", "future", "option"}:
        return max(1, len(ts))
    step = expected_step(interval)
    start = ts.iloc[0].floor("D")
    # Floor the last bar's UTC day so a session ending before midnight UTC does
    # not inflate coverage with an extra calendar day.
    end = ts.iloc[-1].floor("D")
    days = pd.date_range(start, end, freq="D", tz="UTC")
    expected = 0
    for day in days:
        bounds = _exchange_session_bounds(day, asset_class)
        if bounds is None:
            continue
        expected += _bars_in_session(bounds[0], bounds[1], step)
    return max(1, expected)


def _effective_trading_start(start: pd.Timestamp, asset_class: str) -> date:
    """First trading day on or after start for exchange-traded assets."""
    if asset_class not in {"equity", "future", "option"}:
        return start.date()
    cursor = start.date()
    while not is_trading_day(cursor):
        cursor += timedelta(days=1)
    return cursor


def _start_window_reason(
    first: pd.Timestamp,
    start: pd.Timestamp,
    step: pd.Timedelta,
    asset_class: str,
) -> str | None:
    if asset_class in {"equity", "future", "option"}:
        if first.date() > _effective_trading_start(start, asset_class):
            return f"first bar {first} is after requested start {start}"
        return None
    if first > start + step * 1.5:
        return f"first bar {first} is after requested start {start}"
    return None


def _session_close_utc(day: date, asset_class: str) -> pd.Timestamp:
    if asset_class == "future":
        return pd.Timestamp(day.year, day.month, day.day, 23, 0, tz="UTC")
    close = pd.Timestamp(day.year, day.month, day.day, 16, 0, tz="America/New_York")
    return close.tz_convert("UTC")


def _last_completed_session_day(now: pd.Timestamp, asset_class: str) -> date:
    """Most recent exchange day whose session has already closed at `now`."""
    tz = "UTC" if asset_class == "future" else "America/New_York"
    cursor = now.tz_convert(tz).date()
    for _ in range(10):
        if is_trading_day(cursor) and now >= _session_close_utc(cursor, asset_class):
            return cursor
        cursor -= timedelta(days=1)
    return cursor


def _effective_trading_end(end: pd.Timestamp, asset_class: str, now: pd.Timestamp) -> date:
    """Last trading day on or before end whose session has closed at `now`.

    Mirror of _effective_trading_start: strict mode must not demand a bar for
    a weekend, a market holiday, a future date, or a session that has not
    finished trading yet (e.g. a daily backtest requested intraday with end
    date = today).
    """
    if asset_class not in {"equity", "future", "option"}:
        return end.date()
    cursor = min(end.date(), _last_completed_session_day(now, asset_class))
    while not is_trading_day(cursor):
        cursor -= timedelta(days=1)
    return cursor


def _completed_bar_exclusive_end(now: pd.Timestamp, step: pd.Timedelta) -> pd.Timestamp:
    """Exclusive upper bound of bar timestamps that can be complete at `now`."""
    return now.floor(step if step < pd.Timedelta(days=1) else "D")


def completed_window_exclusive_end(
    requested_end: str,
    interval: str,
    asset_class: str,
    now: pd.Timestamp | None = None,
) -> pd.Timestamp:
    """Exclusive fetch upper bound for a requested end DATE (YYYY-MM-DD).

    Providers treat their `end` argument as a timestamp bound, so passing the
    end date verbatim silently drops the end date's own bars (midnight is the
    START of that day). This returns end-of-day instead, capped so bars from
    sessions/periods still in progress at `now` stay out. Derived from the same
    session logic as the strict end-window gate, so a fetch bounded by this
    value always satisfies the gate.
    """
    now = now if now is not None else pd.Timestamp.now(tz="UTC")
    end = pd.to_datetime(requested_end, utc=True) + pd.Timedelta(days=1)
    if asset_class in {"equity", "future", "option"}:
        last_day = _last_completed_session_day(now, asset_class)
        cap = pd.Timestamp(last_day.year, last_day.month, last_day.day, tz="UTC") + pd.Timedelta(days=1)
        return min(end, cap)
    return min(end, _completed_bar_exclusive_end(now, expected_step(interval)))


def _timestamp_end_window_reason(
    last: pd.Timestamp,
    requested_end: str,
    step: pd.Timedelta,
    now: pd.Timestamp,
) -> str | None:
    requested = pd.to_datetime(requested_end, utc=True)
    effective_end = min(requested, _completed_bar_exclusive_end(now, step))
    if last < effective_end:
        return (
            f"last bar {last} is before requested timestamp end {requested_end}"
            f" (completed-bar cutoff {effective_end})"
        )
    return None


def _date_end_window_reason(
    last: pd.Timestamp,
    requested_end: str,
    step: pd.Timedelta,
    asset_class: str,
    now: pd.Timestamp,
) -> str | None:
    end = pd.to_datetime(requested_end, utc=True) + pd.Timedelta(days=1)
    if asset_class in {"equity", "future", "option"}:
        effective_end = _effective_trading_end(end - pd.Timedelta(days=1), asset_class, now)
        if last.date() < effective_end:
            return (
                f"last bar {last} is before requested end {requested_end}"
                f" (last completable session {effective_end})"
            )
        return None
    effective_exclusive = min(end, _completed_bar_exclusive_end(now, step))
    if last < effective_exclusive - step * 1.5:
        return (
            f"last bar {last} is before requested end {requested_end}"
            f" (completed-bar cutoff {effective_exclusive})"
        )
    return None


def _end_window_reason(
    last: pd.Timestamp,
    requested_end: str,
    step: pd.Timedelta,
    asset_class: str,
    now: pd.Timestamp | None = None,
) -> str | None:
    now = now if now is not None else pd.Timestamp.now(tz="UTC")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", requested_end):
        return _date_end_window_reason(last, requested_end, step, asset_class, now)
    return _timestamp_end_window_reason(last, requested_end, step, now)


def _outlier_indexes_and_details(
    df: pd.DataFrame,
    provider: str = "unknown",
    interval: str = "1m",
    asset_class: str = "crypto_spot",
) -> Tuple[List[int], List[OutlierDetail]]:
    c = df["close"].to_numpy()
    ts = pd.to_datetime(df["timestamp"], utc=True)
    log_ret = np.diff(np.log(np.clip(c, 1e-12, None)))
    continuous = _continuous_return_mask(ts, interval, asset_class)
    scored = log_ret[continuous]
    if scored.size <= 30:
        return [], []
    mu, sd = float(scored.mean()), float(scored.std(ddof=0))
    median = float(np.median(scored))
    mad = float(np.median(np.abs(scored - median)))
    if sd <= 0 and mad <= 0:
        return [], []
    min_abs_return = _minimum_outlier_log_return(interval, asset_class)
    idxs: List[int] = []
    details: List[OutlierDetail] = []
    for i, r in enumerate(log_ret):
        if not continuous[i]:
            continue
        std_z = float((r - mu) / sd) if sd > 0 else 0.0
        robust_z = float(0.6745 * (r - median) / mad) if mad > 0 else 0.0
        z = robust_z if abs(robust_z) > abs(std_z) else std_z
        if abs(z) > 8.0 and abs(float(r)) >= min_abs_return:
            row_idx = i + 1
            idxs.append(row_idx)
            details.append(OutlierDetail(
                timestamp=str(ts.iloc[row_idx]),
                previous_close=float(c[i]),
                current_close=float(c[row_idx]),
                log_return=float(r),
                z_score=z,
                provider=provider,
            ))
    return idxs, details


def repair_isolated_outliers(
    df: pd.DataFrame,
    provider: str = "unknown",
    interval: str = "1m",
    asset_class: str = "crypto_spot",
) -> Tuple[pd.DataFrame, List[OutlierDetail]]:
    """Drop isolated severe outlier rows only.

    This intentionally refuses to repair clusters; clustered moves are more
    likely to be regime events, provider outages, or split/adjustment issues
    that need explicit review.
    """
    if df.empty:
        return df, []
    work = df.sort_values("timestamp").reset_index(drop=True)
    idxs, details = _outlier_indexes_and_details(work, provider, interval, asset_class)
    if not idxs:
        return work, []
    if any((idx + 1) in idxs or (idx - 1) in idxs for idx in idxs):
        return work, []
    repaired = work.drop(index=idxs).reset_index(drop=True)
    return repaired, details


def _timestamp_ranges(timestamps: pd.DatetimeIndex, step: pd.Timedelta) -> List[Dict[str, object]]:
    if len(timestamps) == 0:
        return []
    ranges: List[Dict[str, object]] = []
    range_start = timestamps[0]
    previous = timestamps[0]
    count = 1
    for current in timestamps[1:]:
        if current - previous == step:
            count += 1
        else:
            ranges.append({"start": range_start.isoformat(), "end": previous.isoformat(), "count": count})
            range_start, count = current, 1
        previous = current
    ranges.append({"start": range_start.isoformat(), "end": previous.isoformat(), "count": count})
    return ranges


def _expected_timestamp_set(
    ts: pd.Series,
    interval: str,
    asset_class: str,
    requested_start: str | None,
    requested_end: str | None,
    calendar_id: str | None,
    session_type: str | None,
) -> tuple[pd.DatetimeIndex, str, str, str]:
    from .calendars import CALENDAR_VERSION, ExpectedTimestampRequest, default_calendar_policy, expected_timestamps

    # Regional listings are deliberately provider-observed for now. Their
    # exchange holiday and half-day schedules are not yet implemented in the
    # strict calendar registry, so using XNYS here would fabricate missing or
    # extra bars. This mode validates schema, ordering, OHLC, duplicates and
    # outliers while remaining non-promotable via AssetSpec.productionEligible.
    regional_calendars = {"XNSE", "XBOM", "XTSE", "XTSX", "XEUR", "XHKG", "XSHG", "XSHE"}
    if calendar_id and calendar_id.upper() in regional_calendars:
        observed = pd.DatetimeIndex(ts).drop_duplicates().sort_values()
        return observed, calendar_id.upper(), "provider-observed-v1", "provider_observed"

    policy = default_calendar_policy(asset_class, session_type)
    start = requested_start or ts.iloc[0].date().isoformat()
    end = requested_end or ts.iloc[-1].date().isoformat()
    expected = expected_timestamps(
        ExpectedTimestampRequest(
            requested_start=start,
            requested_end=end,
            interval=interval,
            asset_class=asset_class,
            calendar_id=calendar_id,
            session_type=session_type,
        )
    )
    if requested_start is None and requested_end is None and policy.calendar_id in {"24/7", "FX_24_5"}:
        expected = expected[(expected >= ts.iloc[0]) & (expected <= ts.iloc[-1])]
    return expected, policy.calendar_id, CALENDAR_VERSION, policy.session_type


def analyze(
    df: pd.DataFrame,
    interval: str,
    asset_class: str = "crypto_spot",
    provider: str = "unknown",
    requested_start: str | None = None,
    requested_end: str | None = None,
    calendar_id: str | None = None,
    session_type: str | None = None,
    incomplete_final_bar_count: int = 0,
) -> QualityReport:
    if df.empty:
        return QualityReport(0, 0.0, 0, 0, 0, 0, 0, ["empty input"])
    # Sort by timestamp first — gap/coverage/outlier math is sequential and
    # silently distorted by unsorted input.
    df = df.sort_values("timestamp").reset_index(drop=True)
    ts = pd.to_datetime(df["timestamp"], utc=True)
    o, h, low, c = df["open"].to_numpy(), df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy()
    v = df["volume"].to_numpy()

    # Duplicates
    dupes = int(ts.duplicated().sum())

    # OHLC sanity: high >= max(open, close) and low <= min(open, close)
    ohlc_viol = int(((low > o) | (low > c) | (h < o) | (h < c) | (h < low)).sum())

    # Outliers (>8σ close moves)
    _, outlier_details = _outlier_indexes_and_details(df, provider, interval, asset_class)
    outliers = len(outlier_details)

    # Zero volume
    zero_vol = int((v <= 0).sum())

    # Exact calendar reconciliation. Duplicate rows are counted separately by
    # the schema check but collapse to one actual timestamp for completeness.
    step = expected_step(interval)
    expected_ts, effective_calendar, calendar_version, effective_session = _expected_timestamp_set(
        ts, interval, asset_class, requested_start, requested_end, calendar_id, session_type
    )
    actual_ts = pd.DatetimeIndex(ts).drop_duplicates().sort_values()
    missing_ts = expected_ts.difference(actual_ts)
    extra_ts = actual_ts.difference(expected_ts)
    expected_count = len(expected_ts)
    actual_in_window = len(actual_ts.intersection(expected_ts))
    coverage = actual_in_window / expected_count if expected_count else 0.0
    gaps = len(missing_ts)

    notes: List[str] = []
    if dupes:
        notes.append(f"{dupes} duplicate timestamp(s)")
    if ohlc_viol:
        notes.append(f"{ohlc_viol} OHLC sanity violation(s)")
    if outliers:
        notes.append(f"{outliers} >8σ outlier bar(s)")
    if zero_vol > len(ts) * 0.05:
        notes.append(f"{zero_vol} zero-volume bars ({zero_vol/len(ts):.1%})")
    if gaps:
        notes.append(f"{gaps} expected timestamp(s) missing from {effective_calendar}")
    if len(extra_ts):
        notes.append(f"{len(extra_ts)} timestamp(s) outside the expected calendar/session")
    if incomplete_final_bar_count:
        notes.append(f"{incomplete_final_bar_count} incomplete final bar(s)")

    return QualityReport(
        n_bars=len(ts), coverage_pct=float(coverage), gap_count=gaps,
        duplicate_ts_count=dupes, ohlc_violations=ohlc_viol,
        outlier_bars=outliers, zero_volume_bars=zero_vol, notes=notes,
        outlier_details=outlier_details,
        expected_timestamp_count=expected_count,
        actual_timestamp_count=len(actual_ts),
        missing_timestamp_count=len(missing_ts),
        extra_timestamp_count=len(extra_ts),
        missing_timestamps=[value.isoformat() for value in missing_ts],
        extra_timestamps=[value.isoformat() for value in extra_ts],
        missing_ranges=_timestamp_ranges(missing_ts, step),
        incomplete_final_bar_count=incomplete_final_bar_count,
        calendar_id=effective_calendar,
        calendar_version=calendar_version,
        session_type=effective_session,
    )


def report_with_repair(report: QualityReport, repaired_details: List[OutlierDetail]) -> QualityReport:
    report.repaired_outliers = len(repaired_details)
    report.repair_applied = len(repaired_details) > 0
    if repaired_details:
        report.notes.append(f"repaired {len(repaired_details)} isolated outlier bar(s)")
        report.outlier_details = repaired_details
    return report


def blocking_reasons(report: QualityReport, asset_class: str, missing_threshold: float = 0.95) -> List[str]:
    reasons: List[str] = []
    if report.n_bars <= 0:
        reasons.append("empty input")
    if report.duplicate_ts_count > 0:
        reasons.append(f"{report.duplicate_ts_count} duplicate timestamp(s)")
    if report.ohlc_violations > 0:
        reasons.append(f"{report.ohlc_violations} invalid OHLC bar(s)")
    if report.coverage_pct < missing_threshold:
        reasons.append(f"coverage {report.coverage_pct:.1%} below {missing_threshold:.0%} threshold")
    # Missing timestamps remain explicit in QualityReport, but the configured
    # coverage threshold decides whether they are fatal. Treating any single
    # gap as fatal made missing_threshold dead code and caused high-coverage
    # provider datasets to retry forever.
    if report.extra_timestamp_count > 0:
        reasons.append(f"{report.extra_timestamp_count} timestamp(s) outside expected calendar/session")
    if report.incomplete_final_bar_count > 0:
        reasons.append("final candle is incomplete")
    if report.outlier_bars > 0:
        reasons.append(f"{report.outlier_bars} severe outlier bar(s)")
    if asset_class in {"crypto_spot", "crypto_perp"} and report.zero_volume_bars > 0:
        reasons.append(f"{report.zero_volume_bars} zero-volume bar(s)")
    if asset_class in {"equity", "future", "option"} and report.zero_volume_bars > 0 and report.session_type != "provider_observed":
        isolated_tolerance = max(3, int(np.ceil(report.n_bars * 0.01)))
        if report.zero_volume_bars > isolated_tolerance:
            reasons.append(f"{report.zero_volume_bars} zero-volume bar(s)")
    return reasons


def _maybe_start_window_reason(
    first: pd.Timestamp,
    requested_start: str | None,
    step: pd.Timedelta,
    asset_class: str,
) -> str | None:
    if not requested_start:
        return None
    start = pd.to_datetime(requested_start, utc=True)
    return _start_window_reason(first, start, step, asset_class)


def _maybe_end_window_reason(
    last: pd.Timestamp,
    requested_end: str | None,
    step: pd.Timedelta,
    asset_class: str,
    now: pd.Timestamp | None = None,
) -> str | None:
    if not requested_end:
        return None
    return _end_window_reason(last, requested_end, step, asset_class, now)


def requested_window_reasons(
    df: pd.DataFrame,
    interval: str,
    asset_class: str,
    requested_start: str | None,
    requested_end: str | None,
    now: pd.Timestamp | None = None,
) -> List[str]:
    """Strict-mode guard against silently truncated provider windows."""
    if df.empty:
        return ["empty input"]
    step = expected_step(interval)
    ts = pd.to_datetime(df["timestamp"], utc=True)
    return [
        reason for reason in (
            _maybe_start_window_reason(ts.iloc[0], requested_start, step, asset_class),
            _maybe_end_window_reason(ts.iloc[-1], requested_end, step, asset_class, now),
        )
        if reason
    ]
