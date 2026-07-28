"""Data quality + cache."""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.data.cache import (
    CacheConfig,
    _existing_partition,
    _partition_dir,
    _safe_symbol,
    _write_partition_path,
    load_range,
)
from engine_v2.data.quality import QualityReport, analyze, blocking_reasons, expected_step
from engine_v2.cli import _load_csv, _resample
from engine_v2.core.arrays import MarketSnapshot, from_dataframe


def _toy_df(n: int = 200, gap_at: int = -1) -> pd.DataFrame:
    ts = pd.date_range("2024-01-01", periods=n, freq="1min", tz="UTC")
    if gap_at >= 0:
        ts = ts.delete(gap_at)
    n = len(ts)
    rng = np.random.default_rng(42)
    base = 100 + np.cumsum(rng.standard_normal(n) * 0.1)
    close = base + rng.standard_normal(n) * 0.05
    high = np.maximum(base, close) + 0.5
    low = np.minimum(base, close) - 0.5
    return pd.DataFrame({
        "timestamp": ts,
        "open": base, "high": high, "low": low, "close": close,
        "volume": rng.uniform(1, 10, size=n),
    })


def test_quality_clean_data():
    rep = analyze(_toy_df(), "1m", "crypto")
    assert rep.gap_count == 0
    assert rep.duplicate_ts_count == 0
    assert rep.ohlc_violations == 0
    assert rep.zero_volume_bars == 0
    assert rep.coverage_pct >= 0.99


def test_point_in_time_snapshot_survives_strict_engine_csv_path(tmp_path):
    snapshot = {
        "schema_version": 1,
        "bar_time": "2026-07-28T12:00:00Z",
        "symbol": "SPY",
        "bar": {"open": "100", "high": "101", "low": "99", "close": "100"},
        "features": {"horizons": {"1h": {"ema_slope": "0.1"}}},
        "regime": {"composite": "risk_on_trend"},
        "context": {},
    }
    frame = _toy_df(2)
    frame["finny_snapshot_json"] = ["", json.dumps(snapshot)]
    csv_path = tmp_path / "snapshot.csv"
    frame.to_csv(csv_path, index=False)

    loaded = _resample(_load_csv(csv_path), "1m")
    assert "finny_snapshot_json" in loaded.columns
    arrays = from_dataframe(loaded, symbol="SPY")
    market = MarketSnapshot({"SPY": arrays})
    market.set_index(0)
    assert "finny_snapshot" not in market.decision_safe_bar("SPY")
    market.set_index(1)
    assert market.decision_safe_bar("SPY")["finny_snapshot"] == snapshot


def test_point_in_time_snapshot_fails_closed_when_resampling():
    frame = _toy_df(3)
    frame["finny_snapshot_json"] = ["", "{}", ""]
    with pytest.raises(ValueError, match="cannot be resampled"):
        _resample(frame, "5m")


def test_quality_sorts_unsorted_input():
    df = _toy_df(100)
    # Shuffle deterministically
    df = df.sample(frac=1, random_state=0).reset_index(drop=True)
    rep = analyze(df, "1m", "crypto")
    # If we hadn't sorted, gap_count would be huge from negative diffs
    assert rep.gap_count == 0
    assert rep.coverage_pct >= 0.99


def test_quality_detects_gap_and_dupe():
    df = _toy_df(gap_at=50)
    df = pd.concat([df, df.iloc[[10]]], ignore_index=True).sort_values("timestamp")
    rep = analyze(df, "1m", "crypto")
    assert rep.duplicate_ts_count >= 1
    assert rep.gap_count >= 1


def test_quality_detects_ohlc_violation():
    df = _toy_df(50)
    df.loc[10, "low"] = df.loc[10, "high"] + 1.0   # low > high
    rep = analyze(df, "1m", "crypto")
    assert rep.ohlc_violations >= 1


def _worker_write_cache(args):
    root, _idx = args
    cfg = CacheConfig(root=Path(root), provider="test")
    df = _toy_df(50)

    def fetch(s: str, e: str) -> pd.DataFrame:
        return df

    out = load_range(cfg, "TEST/SYM", "1m",
                     pd.Timestamp("2024-01-01", tz="UTC"),
                     pd.Timestamp("2024-01-02", tz="UTC"),
                     fetch)
    return len(out)


def test_safe_symbol_rejects_path_traversal():
    import pytest
    with pytest.raises(ValueError):
        _safe_symbol("..")
    with pytest.raises(ValueError):
        _safe_symbol(".")
    with pytest.raises(ValueError):
        _safe_symbol("")
    with pytest.raises(ValueError):
        _safe_symbol("...")  # 3 dots → lstrip strips, leaves empty… actually ".."?
    # Normal symbols pass and slashes become underscores
    assert _safe_symbol("ETH/USD") == "ETH_USD"
    assert _safe_symbol("BRK.B") == "BRK.B"
    assert _safe_symbol("BTC-USD") == "BTC-USD"


def test_partition_read_falls_back_across_formats(tmp_path):
    """A partition written as .csv (e.g. when pyarrow was unavailable) must
    still be found by a process that has pyarrow installed."""
    d = _partition_dir(tmp_path, "yfinance", "TEST", "1m")
    d.mkdir(parents=True)
    # Simulate an older write as CSV
    csv_path = d / "2024.csv"
    pd.DataFrame({"timestamp": [pd.Timestamp("2024-01-01", tz="UTC")],
                  "open": [1.0], "high": [1.0], "low": [1.0],
                  "close": [1.0], "volume": [1.0]}).to_csv(csv_path, index=False)
    found = _existing_partition(d, 2024)
    assert found is not None and found.suffix == ".csv"


def test_expected_step_bare_unit_letters():
    assert expected_step("h") == pd.Timedelta(hours=1)
    assert expected_step("d") == pd.Timedelta(days=1)
    assert expected_step("m") == pd.Timedelta(minutes=1)
    assert expected_step("4h") == pd.Timedelta(hours=4)
    assert expected_step("15m") == pd.Timedelta(minutes=15)


def test_equity_intraday_outlier_requires_material_move():
    ts = pd.date_range("2026-06-11T13:30:00Z", periods=120, freq="5min", tz="UTC")
    prices = np.full(len(ts), 726.07)
    prices += np.sin(np.arange(len(ts))) * 0.05
    prices[47] = 732.52  # ~0.89% 5-minute move, plausible for SPY during a rally.
    prices[48:] += 6.45
    df = pd.DataFrame({
        "timestamp": ts,
        "open": prices,
        "high": prices + 0.5,
        "low": prices - 0.5,
        "close": prices,
        "volume": 1_000_000,
    })

    rep = analyze(df, "5min", "equity", provider="test")

    assert rep.outlier_bars == 0


def test_equity_intraday_outlier_keeps_large_bad_bar():
    ts = pd.date_range("2026-06-11T13:30:00Z", periods=120, freq="5min", tz="UTC")
    prices = np.full(len(ts), 100.0)
    prices += np.sin(np.arange(len(ts))) * 0.02
    prices[47] = 120.0
    df = pd.DataFrame({
        "timestamp": ts,
        "open": prices,
        "high": prices + 0.5,
        "low": prices - 0.5,
        "close": prices,
        "volume": 1_000_000,
    })

    rep = analyze(df, "5min", "equity", provider="test")

    assert rep.outlier_bars >= 1


def test_equity_daily_outlier_tolerates_real_market_shock():
    ts = pd.date_range("2025-06-01", periods=220, freq="B", tz="UTC")
    prices = np.full(len(ts), 495.90)
    prices += np.sin(np.arange(len(ts))) * 0.20
    prices[160] = 444.95  # ~10.8% daily drop, large but plausible for strict daily equity data.
    prices[161:] -= 50.95
    df = pd.DataFrame({
        "timestamp": ts,
        "open": prices,
        "high": prices + 25.0,
        "low": prices - 25.0,
        "close": prices,
        "volume": 1_000_000,
    })

    rep = analyze(df, "1d", "equity", provider="test")

    assert rep.outlier_bars == 0


def test_equity_daily_outlier_keeps_impossible_bad_bar():
    ts = pd.date_range("2025-06-01", periods=220, freq="B", tz="UTC")
    prices = np.full(len(ts), 100.0)
    prices += np.sin(np.arange(len(ts))) * 0.02
    prices[160] = 150.0
    df = pd.DataFrame({
        "timestamp": ts,
        "open": prices,
        "high": prices + 5.0,
        "low": prices - 5.0,
        "close": prices,
        "volume": 1_000_000,
    })

    rep = analyze(df, "1d", "equity", provider="test")

    assert rep.outlier_bars >= 1


def test_equity_zero_volume_tolerates_isolated_provider_artifacts():
    report = QualityReport(
        n_bars=1716,
        coverage_pct=1.0,
        gap_count=0,
        duplicate_ts_count=0,
        ohlc_violations=0,
        outlier_bars=0,
        zero_volume_bars=1,
    )

    assert blocking_reasons(report, "equity") == []


def test_equity_zero_volume_blocks_material_clusters():
    report = QualityReport(
        n_bars=300,
        coverage_pct=1.0,
        gap_count=0,
        duplicate_ts_count=0,
        ohlc_violations=0,
        outlier_bars=0,
        zero_volume_bars=8,
    )

    assert "8 zero-volume bar(s)" in blocking_reasons(report, "equity")


def test_cache_concurrent_writes_no_corruption(tmp_path):
    args = [(str(tmp_path), i) for i in range(4)]
    with mp.get_context("spawn").Pool(processes=4) as pool:
        results = pool.map(_worker_write_cache, args)
    # All workers should get the same row count (cache stable)
    assert len(set(results)) == 1
    # Re-read after the storm: still readable
    cfg = CacheConfig(root=tmp_path, provider="test")
    df = load_range(cfg, "TEST/SYM", "1m",
                    pd.Timestamp("2024-01-01", tz="UTC"),
                    pd.Timestamp("2024-01-02", tz="UTC"),
                    lambda s, e: pd.DataFrame())
    assert len(df) > 0


def test_fetch_end_bound_covers_full_end_day():
    from engine_v2.data.providers.base import fetch_end_bound_utc

    bound = fetch_end_bound_utc("2024-03-15")
    # Date-only end is inclusive of the whole calendar day: the exclusive
    # bound is midnight of the following day, so a daily bar stamped at
    # 04:00 UTC on the end date is inside the window.
    assert bound == pd.Timestamp("2024-03-16", tz="UTC")
    assert pd.Timestamp("2024-03-15 04:00", tz="UTC") < bound


def test_fetch_end_bound_keeps_explicit_timestamps():
    from engine_v2.data.providers.base import fetch_end_bound_utc

    bound = fetch_end_bound_utc("2024-03-15T12:30:00Z")
    assert bound == pd.Timestamp("2024-03-15 12:30", tz="UTC")

    # An explicit intraday timestamp on the current day refers to already
    # completed bars — it must not be capped to today's midnight.
    same_day = pd.Timestamp.now(tz="UTC").floor("min") - pd.Timedelta(hours=1)
    assert fetch_end_bound_utc(same_day.isoformat()) == same_day


def test_fetch_end_bound_caps_at_current_utc_midnight():
    from engine_v2.data.providers.base import fetch_end_bound_utc

    today = pd.Timestamp.now(tz="UTC").normalize()
    # A window ending today (or later) must not include the still-forming
    # current-day bar in a strict run.
    assert fetch_end_bound_utc(str(today.date())) == today
    assert fetch_end_bound_utc(str((today + pd.Timedelta(days=30)).date())) == today
