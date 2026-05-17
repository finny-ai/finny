"""Data quality + cache."""

from __future__ import annotations

import multiprocessing as mp
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.data.cache import (
    CacheConfig,
    _existing_partition,
    _partition_dir,
    _safe_symbol,
    _write_partition_path,
    load_range,
)
from engine_v2.data.quality import analyze, expected_step


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
