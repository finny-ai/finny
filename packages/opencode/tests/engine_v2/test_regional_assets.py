from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.assets import normalize_asset_class, resolve_asset_spec
from engine_v2.core.clock import calendar_bars_per_year
from engine_v2.data.quality import analyze, blocking_reasons
from engine_v2.cli import _apply_regular_hours_filter


def test_regional_asset_specs_are_equities_and_research_only():
    india = resolve_asset_spec({"symbol": "BAJAJ-AUTO.NS"})
    assert normalize_asset_class(None, "BAJAJ-AUTO.NS") == "equity"
    assert india.currency == "INR"
    assert india.calendar == "XNSE"
    assert india.dataProvider == "zerodha"
    assert india.productionEligible is False

    assert resolve_asset_spec({"symbol": "SHOP.TO"}).currency == "CAD"
    assert resolve_asset_spec({"symbol": "ASML.AS"}).currency == "EUR"
    assert resolve_asset_spec({"symbol": "600519.SS"}).lotSize == 100.0


def test_regional_calendar_annualization_uses_local_session_length():
    assert calendar_bars_per_year("1m", "XNSE") == 375.0 * 252.0
    assert calendar_bars_per_year("1m", "XSHG") == 240.0 * 252.0


def test_regional_quality_is_explicitly_provider_observed():
    frame = pd.DataFrame({
        "timestamp": pd.to_datetime(["2026-01-02", "2026-01-05"], utc=True),
        "open": [100.0, 101.0],
        "high": [102.0, 103.0],
        "low": [99.0, 100.0],
        "close": [101.0, 102.0],
        "volume": [1000.0, 1100.0],
    })
    report = analyze(
        frame,
        "1d",
        "equity",
        provider="zerodha",
        requested_start="2026-01-01",
        requested_end="2026-01-06",
        calendar_id="XNSE",
    )

    assert report.calendar_id == "XNSE"
    assert report.calendar_version == "provider-observed-v1"
    assert report.session_type == "provider_observed"
    assert report.coverage_pct == 1.0
    assert blocking_reasons(report, "equity") == []


def test_indian_regular_hours_filter_uses_nse_timezone_and_session():
    frame = pd.DataFrame({
        "timestamp": pd.to_datetime([
            "2026-01-02 03:30:00+00:00",
            "2026-01-02 03:45:00+00:00",
            "2026-01-02 09:15:00+00:00",
            "2026-01-02 10:00:00+00:00",
        ]),
        "open": [1.0] * 4,
        "high": [1.0] * 4,
        "low": [1.0] * 4,
        "close": [1.0] * 4,
        "volume": [1.0] * 4,
    })
    filtered = _apply_regular_hours_filter(frame, "equity", {}, "15m", "XNSE")
    assert len(filtered) == 2


def test_provider_observed_regional_zero_volume_is_diagnostic_not_blocking():
    report = analyze(
        pd.DataFrame({
            "timestamp": pd.to_datetime(["2026-01-02", "2026-01-05"], utc=True),
            "open": [100.0, 101.0],
            "high": [102.0, 103.0],
            "low": [99.0, 100.0],
            "close": [101.0, 102.0],
            "volume": [0.0, 0.0],
        }),
        "1d",
        "equity",
        provider="yfinance",
        calendar_id="XNSE",
    )
    assert report.zero_volume_bars == 2
    assert blocking_reasons(report, "equity") == []
