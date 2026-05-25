"""Data-quality detectors and hard gates for strict backtests."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

import numpy as np
import pandas as pd


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


def analyze(df: pd.DataFrame, interval: str, asset_class: str = "crypto_spot") -> QualityReport:
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

    # OHLC sanity: low ≤ open,close ≤ high
    ohlc_viol = int(((low > o) | (low > c) | (h < o) | (h < c) | (h < low)).sum())

    # Outliers (>8σ close moves)
    log_ret = np.diff(np.log(np.clip(c, 1e-12, None)))
    if log_ret.size > 30:
        mu, sd = float(log_ret.mean()), float(log_ret.std(ddof=0))
        outliers = int(np.sum(np.abs(log_ret - mu) > 8.0 * sd)) if sd > 0 else 0
    else:
        outliers = 0

    # Zero volume
    zero_vol = int((v <= 0).sum())

    # Gaps: count bars where the diff exceeds expected step (crypto-only here;
    # equities skipped because we don't have a market calendar in scope).
    gaps = 0
    if asset_class in {"crypto", "crypto_spot", "crypto_perp", "fx"} and len(ts) > 1:
        diffs = ts.diff().dropna()
        step = expected_step(interval)
        gaps = int((diffs > step * 1.5).sum())
    coverage = 1.0
    if asset_class in {"crypto", "crypto_spot", "crypto_perp", "fx"} and len(ts) > 1:
        actual = len(ts)
        expected = max(1, int((ts.iloc[-1] - ts.iloc[0]) / expected_step(interval)) + 1)
        coverage = min(1.0, actual / expected)

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
    )


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
    if asset_class in {"crypto_spot", "crypto_perp", "equity", "future", "option"} and report.zero_volume_bars > 0:
        reasons.append(f"{report.zero_volume_bars} zero-volume bar(s)")
    return reasons
