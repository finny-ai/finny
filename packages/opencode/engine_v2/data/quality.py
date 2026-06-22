"""Data-quality detectors and hard gates for strict backtests."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd


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
    weekday = day.weekday()
    if weekday >= 5:
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
    """First weekday on or after start for exchange-traded assets."""
    if asset_class not in {"equity", "future", "option"}:
        return start.date()
    cursor = start.date()
    while cursor.weekday() >= 5:
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


def _end_window_reason(
    last: pd.Timestamp,
    requested_end: str,
    step: pd.Timedelta,
    asset_class: str,
) -> str | None:
    end = pd.to_datetime(requested_end, utc=True) + pd.Timedelta(days=1)
    if asset_class in {"equity", "future", "option"}:
        if last.date() < (end - pd.Timedelta(days=1)).date():
            return f"last bar {last} is before requested end {requested_end}"
        return None
    if last < end - step * 1.5:
        return f"last bar {last} is before requested end {requested_end}"
    return None


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


def analyze(df: pd.DataFrame, interval: str, asset_class: str = "crypto_spot", provider: str = "unknown") -> QualityReport:
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

    # Gaps and coverage.
    gaps = 0
    if asset_class in {"crypto", "crypto_spot", "crypto_perp", "fx"} and len(ts) > 1:
        diffs = ts.diff().dropna()
        step = expected_step(interval)
        gaps = int((diffs > step * 1.5).sum())
    if asset_class in {"equity", "future", "option"} and len(ts) > 1:
        diffs = ts.diff().dropna()
        step = expected_step(interval)
        continuous = _continuous_return_mask(ts, interval, asset_class)
        gaps = int(((diffs > step * 1.5).to_numpy() & continuous).sum())
    coverage = 1.0
    if asset_class in {"crypto", "crypto_spot", "crypto_perp", "fx"} and len(ts) > 1:
        actual = len(ts)
        expected = max(1, int((ts.iloc[-1] - ts.iloc[0]) / expected_step(interval)) + 1)
        coverage = min(1.0, actual / expected)
    if asset_class in {"equity", "future", "option"} and len(ts) > 1:
        expected = _exchange_expected_count(ts, interval, asset_class)
        coverage = min(1.0, len(ts) / expected)

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
        notes.append(f"{gaps} gap(s) > 1.5×expected step")

    return QualityReport(
        n_bars=len(ts), coverage_pct=float(coverage), gap_count=gaps,
        duplicate_ts_count=dupes, ohlc_violations=ohlc_viol,
        outlier_bars=outliers, zero_volume_bars=zero_vol, notes=notes,
        outlier_details=outlier_details,
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
    if report.outlier_bars > 0:
        reasons.append(f"{report.outlier_bars} severe outlier bar(s)")
    if asset_class in {"crypto_spot", "crypto_perp"} and report.zero_volume_bars > 0:
        reasons.append(f"{report.zero_volume_bars} zero-volume bar(s)")
    if asset_class in {"equity", "future", "option"} and report.zero_volume_bars > 0:
        isolated_tolerance = max(3, int(np.ceil(report.n_bars * 0.01)))
        if report.zero_volume_bars > isolated_tolerance:
            reasons.append(f"{report.zero_volume_bars} zero-volume bar(s)")
    return reasons


def requested_window_reasons(
    df: pd.DataFrame,
    interval: str,
    asset_class: str,
    requested_start: str | None,
    requested_end: str | None,
) -> List[str]:
    """Strict-mode guard against silently truncated provider windows."""
    if df.empty:
        return ["empty input"]
    step = expected_step(interval)
    ts = pd.to_datetime(df["timestamp"], utc=True)
    reasons: List[str] = []
    if requested_start:
        start = pd.to_datetime(requested_start, utc=True)
        reason = _start_window_reason(ts.iloc[0], start, step, asset_class)
        if reason:
            reasons.append(reason)
    if requested_end:
        reason = _end_window_reason(ts.iloc[-1], requested_end, step, asset_class)
        if reason:
            reasons.append(reason)
    return reasons
