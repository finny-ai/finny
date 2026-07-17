from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.cli import _quality_failure, _resample
from engine_v2.core.clock import calendar_bars_per_year, interval_to_rule_and_bars_per_year
from engine_v2.data.quality import QualityReport


def test_hour_intervals_use_lowercase_pandas_frequency():
    rule_1h, bpy_1h = interval_to_rule_and_bars_per_year("1h")
    rule_4h, bpy_4h = interval_to_rule_and_bars_per_year("4h")

    assert rule_1h == "1h"
    assert rule_4h == "4h"
    assert bpy_1h == 24.0 * 365.0
    assert bpy_4h == 6.0 * 365.0


def test_explicit_extended_equity_calendar_uses_sixteen_hour_session():
    assert calendar_bars_per_year("1m", "US_EQUITIES_EXTENDED") == 16.0 * 60.0 * 252.0


def test_resample_accepts_1h_without_uppercase_frequency_error():
    df = pd.DataFrame({
        "timestamp": pd.date_range("2026-01-01", periods=120, freq="1min", tz="UTC"),
        "open": [100.0] * 120,
        "high": [101.0] * 120,
        "low": [99.0] * 120,
        "close": [100.0] * 120,
        "volume": [1000.0] * 120,
    })

    out = _resample(df, "1h")

    assert len(out) == 2
    assert list(out["volume"]) == [60_000.0, 60_000.0]


def test_resample_accepts_4h_without_uppercase_frequency_error():
    df = pd.DataFrame({
        "timestamp": pd.date_range("2026-01-01", periods=480, freq="1min", tz="UTC"),
        "open": [100.0] * 480,
        "high": [101.0] * 480,
        "low": [99.0] * 480,
        "close": [100.0] * 480,
        "volume": [1000.0] * 480,
    })

    out = _resample(df, "4h")

    assert len(out) == 2
    assert list(out["volume"]) == [240_000.0, 240_000.0]


def test_quality_failure_includes_provider_rows_and_blocking_reasons():
    report = QualityReport(
        n_bars=10,
        coverage_pct=0.8,
        gap_count=2,
        duplicate_ts_count=0,
        ohlc_violations=0,
        outlier_bars=1,
        zero_volume_bars=3,
    )

    msg = _quality_failure(
        "Data quality failed after resample",
        ["1 severe outlier bar(s)", "3 zero-volume bar(s)"],
        report,
        provider="yfinance",
        symbol="BTC/USD",
        interval="1h",
        raw_rows=120,
        post_rows=10,
    )

    assert "Data quality failed after resample: 1 severe outlier bar(s); 3 zero-volume bar(s)" in msg
    assert "provider=yfinance" in msg
    assert "symbol=BTC/USD" in msg
    assert "interval=1h" in msg
    assert "raw_rows=120" in msg
    assert "post_resample_rows=10" in msg
    assert "zero_volume=3" in msg
