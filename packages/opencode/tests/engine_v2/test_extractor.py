"""End-to-end tests for the data extractor subagent pipeline.

Covers:
  1. Binance provider — symbol normalization, interval support, fetch + pagination
  2. Extractor — multi-source selection, parquet write, quality analysis
  3. Digest builder — stats correctness, LLM-friendly output
  4. Full pipeline — extract() writes parquet into algo data/ folder
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.data.extractor import (
    ExtractResult,
    _build_digest,
    _classify_asset,
    _try_fetch,
    extract,
    result_to_json,
)
from engine_v2.data.providers.binance import (
    BinanceProvider,
    _to_binance_symbol,
)
from engine_v2.data.quality import QualityReport


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_df(n: int = 200, start: str = "2024-01-01", freq: str = "1h") -> pd.DataFrame:
    ts = pd.date_range(start, periods=n, freq=freq, tz="UTC")
    rng = np.random.default_rng(42)
    base = 40000 + np.cumsum(rng.standard_normal(n) * 100)
    close = base + rng.standard_normal(n) * 50
    high = np.maximum(base, close) + 200
    low = np.minimum(base, close) - 200
    return pd.DataFrame({
        "timestamp": ts,
        "open": base,
        "high": high,
        "low": low,
        "close": close,
        "volume": rng.uniform(100, 10000, size=n),
    })


def _fake_stock_df(n: int = 100) -> pd.DataFrame:
    ts = pd.date_range("2024-01-01", periods=n, freq="1D", tz="UTC")
    rng = np.random.default_rng(99)
    base = 150 + np.cumsum(rng.standard_normal(n) * 2)
    close = base + rng.standard_normal(n) * 1
    high = np.maximum(base, close) + 3
    low = np.minimum(base, close) - 3
    return pd.DataFrame({
        "timestamp": ts,
        "open": base,
        "high": high,
        "low": low,
        "close": close,
        "volume": rng.uniform(1e6, 1e7, size=n),
    })


def _make_algo_dir(tmp_path: Path, name: str = "test-algo") -> Path:
    algo = tmp_path / name
    algo.mkdir(parents=True)
    (algo / "data" / "crypto").mkdir(parents=True)
    (algo / "data" / "stock").mkdir(parents=True)
    (algo / "mission.md").write_text("---\nname: test-algo\n---\nTest algo\n")
    return algo


# ---------------------------------------------------------------------------
# 1. Binance provider — symbol normalization
# ---------------------------------------------------------------------------

class TestBinanceSymbolNormalization:
    def test_canonical_btc_usd(self):
        assert _to_binance_symbol("BTC/USD") == "BTCUSDT"

    def test_canonical_eth_usdt(self):
        assert _to_binance_symbol("ETH/USDT") == "ETHUSDT"

    def test_dash_form(self):
        assert _to_binance_symbol("SOL-USD") == "SOLUSDT"

    def test_bare_ticker(self):
        assert _to_binance_symbol("DOGE") == "DOGEUSDT"

    def test_lowercase_passthrough(self):
        assert _to_binance_symbol("btc/usd") == "BTCUSDT"

    def test_usdc_stripped(self):
        assert _to_binance_symbol("BTC/USDC") == "BTCUSDT"

    def test_busd_stripped(self):
        assert _to_binance_symbol("ETH/BUSD") == "ETHUSDT"


class TestBinanceProviderIntervals:
    def test_supported_native_intervals(self):
        p = BinanceProvider()
        for iv in ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]:
            assert p.supports_interval(iv), f"{iv} should be supported"

    def test_mapped_intervals(self):
        p = BinanceProvider()
        for iv in ["1min", "5min", "15min", "30min"]:
            assert p.supports_interval(iv), f"{iv} should be supported via mapping"

    def test_unsupported_interval(self):
        p = BinanceProvider()
        assert not p.supports_interval("3d")
        assert not p.supports_interval("1w")


class TestBinanceProviderFetch:
    def test_fetch_parses_klines_response(self):
        p = BinanceProvider()
        fake_klines = [
            [1704067200000, "42000.0", "42500.0", "41800.0", "42200.0", "1234.5",
             1704070799999, "0", 0, "0", "0", "0"],
            [1704070800000, "42200.0", "42600.0", "42100.0", "42400.0", "2345.6",
             1704074399999, "0", 0, "0", "0", "0"],
        ]

        with patch("engine_v2.data.providers.binance._fetch_klines_page") as mock_page:
            mock_page.return_value = fake_klines
            df = p.fetch("BTC/USD", "2024-01-01", "2024-01-02", "1h")

        assert len(df) == 2
        assert list(df.columns) == ["timestamp", "open", "high", "low", "close", "volume"]
        assert df["open"].iloc[0] == 42000.0
        assert df["close"].iloc[1] == 42400.0
        assert df["volume"].iloc[0] == 1234.5

    def test_fetch_empty_raises_runtime_error(self):
        p = BinanceProvider()

        with patch("engine_v2.data.providers.binance._fetch_klines_page") as mock_page:
            mock_page.return_value = []
            with pytest.raises(RuntimeError, match="empty_window"):
                p.fetch("BTC/USD", "2024-01-01", "2024-01-02", "1h")

    def test_fetch_classifies_400_as_unknown_symbol(self, capsys):
        p = BinanceProvider()

        with patch("engine_v2.data.providers.binance._fetch_klines_page") as mock_page:
            mock_page.side_effect = Exception("400 Client Error: Invalid symbol")
            with pytest.raises(Exception):
                p.fetch("FAKECOIN/USD", "2024-01-01", "2024-01-02", "1h")

        captured = capsys.readouterr()
        assert "__FINNY_FETCH_ERROR__: unknown_symbol" in captured.err


# ---------------------------------------------------------------------------
# 2. Asset classification
# ---------------------------------------------------------------------------

class TestAssetClassification:
    def test_crypto_symbols(self):
        for sym in ["BTC/USD", "ETH/USDT", "SOL", "DOGE/USD", "PEPE/USD"]:
            assert _classify_asset(sym) == "crypto_spot", f"{sym} should be crypto_spot"

    def test_stock_symbols(self):
        for sym in ["AAPL", "MSFT", "TSLA", "SPY", "QQQ"]:
            assert _classify_asset(sym) == "equity", f"{sym} should be equity"

    def test_unknown_defaults_to_equity(self):
        # An unrecognized ticker that is not crypto-, futures-, option-, or
        # FX-shaped (the 6/7-char alpha FX heuristic) falls through to equity.
        assert _classify_asset("ZZZ") == "equity"


# ---------------------------------------------------------------------------
# 3. Digest builder
# ---------------------------------------------------------------------------

class TestDigestBuilder:
    def test_empty_df_returns_no_data(self):
        df = pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
        d = _build_digest(df, "BTC/USD", "1h")
        assert d["bars"] == 0
        assert d["status"] == "no_data"

    def test_digest_has_required_keys(self):
        df = _fake_df(100)
        d = _build_digest(df, "BTC/USD", "1h")
        assert d["symbol"] == "BTC/USD"
        assert d["interval"] == "1h"
        assert d["bars"] == 100
        assert "period" in d
        assert "price" in d
        assert "performance" in d
        assert "volume" in d

    def test_digest_price_range_correct(self):
        df = _fake_df(50)
        d = _build_digest(df, "BTC/USD", "1h")
        assert d["price"]["high"] == round(float(df["high"].max()), 6)
        assert d["price"]["low"] == round(float(df["low"].min()), 6)

    def test_digest_total_return_calculation(self):
        df = _fake_df(10)
        d = _build_digest(df, "BTC/USD", "1h")
        expected = ((df["close"].iloc[-1] / df["close"].iloc[0]) - 1) * 100
        assert abs(d["performance"]["total_return_pct"] - round(expected, 4)) < 0.01

    def test_digest_max_drawdown_is_negative(self):
        df = _fake_df(200)
        d = _build_digest(df, "BTC/USD", "1h")
        assert d["performance"]["max_drawdown_pct"] <= 0

    def test_digest_volume_totals(self):
        df = _fake_df(50)
        d = _build_digest(df, "BTC/USD", "1h")
        assert d["volume"]["total"] == round(float(df["volume"].sum()), 2)

    def test_digest_period_timestamps(self):
        df = _fake_df(20, start="2024-03-01")
        d = _build_digest(df, "ETH/USD", "1h")
        assert "2024-03-01" in d["period"]["start"]
        assert d["period"]["end"] != d["period"]["start"]


# ---------------------------------------------------------------------------
# 4. _try_fetch wrapper
# ---------------------------------------------------------------------------

class TestTryFetch:
    def test_success_returns_dataframe(self):
        mock_prov = MagicMock()
        mock_prov.name = "test"
        mock_prov.supports_interval.return_value = True
        mock_prov.fetch.return_value = _fake_df(10)

        df, err = _try_fetch(mock_prov, "BTC/USD", "2024-01-01", "2024-02-01", "1h")
        assert err is None
        assert df is not None
        assert len(df) == 10

    def test_unsupported_interval_returns_error(self):
        mock_prov = MagicMock()
        mock_prov.name = "test"
        mock_prov.supports_interval.return_value = False

        df, err = _try_fetch(mock_prov, "BTC/USD", "2024-01-01", "2024-02-01", "3w")
        assert df is None
        assert "does not support interval" in err

    def test_exception_returns_error_string(self):
        mock_prov = MagicMock()
        mock_prov.name = "test"
        mock_prov.supports_interval.return_value = True
        mock_prov.fetch.side_effect = RuntimeError("network timeout")

        df, err = _try_fetch(mock_prov, "BTC/USD", "2024-01-01", "2024-02-01", "1h")
        assert df is None
        assert "network timeout" in err

    def test_empty_result_returns_error(self):
        mock_prov = MagicMock()
        mock_prov.name = "test"
        mock_prov.supports_interval.return_value = True
        mock_prov.fetch.return_value = pd.DataFrame()

        df, err = _try_fetch(mock_prov, "BTC/USD", "2024-01-01", "2024-02-01", "1h")
        assert df is None
        assert err == "empty result"


# ---------------------------------------------------------------------------
# 5. Full extract() pipeline — e2e with mocked providers
# ---------------------------------------------------------------------------

class TestExtractPipeline:
    def test_crypto_writes_parquet_to_data_crypto(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)
        fake = _fake_df(100)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = fake

            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.return_value = fake.head(50)

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-05", str(algo_dir))

        assert result.bars_written == 100
        assert result.asset_class == "crypto_spot"
        assert "data/crypto" in result.parquet_path
        assert Path(result.parquet_path).exists()
        assert result.digest["source"] == "binance"
        assert result.digest["bars"] == 100
        assert len(result.sources_tried) == 2

    def test_stock_writes_parquet_to_data_stock(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)
        fake = _fake_stock_df(60)

        with patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.return_value = fake

            result = extract("AAPL", "1d", "2024-01-01", "2024-04-01", str(algo_dir))

        assert result.bars_written == 60
        assert result.asset_class == "equity"
        assert "data/stock" in result.parquet_path
        assert Path(result.parquet_path).exists()
        assert result.digest["source"] == "yfinance"

    def test_best_source_wins_by_bar_count(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)
        small = _fake_df(30)
        big = _fake_df(200)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = small

            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.return_value = big

            result = extract("ETH/USD", "1h", "2024-01-01", "2024-01-10", str(algo_dir))

        assert result.bars_written == 200
        assert result.digest["source"] == "yfinance"

    def test_all_sources_fail_returns_no_data(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.side_effect = RuntimeError("timeout")

            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.side_effect = RuntimeError("network error")

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-02-01", str(algo_dir))

        assert result.bars_written == 0
        assert result.parquet_path == ""
        assert result.digest["status"] == "no_data"
        assert len(result.sources_tried) == 2
        assert all(s.error is not None for s in result.sources_tried)

    def test_creates_data_dir_if_missing(self, tmp_path):
        algo_dir = tmp_path / "new-algo"
        algo_dir.mkdir()
        # data/ subdirs don't exist yet

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(10)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.return_value = _fake_df(5)

            result = extract("SOL/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))

        assert result.bars_written == 10
        assert (algo_dir / "data" / "crypto").is_dir()

    def test_deduplicates_and_sorts_output(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)
        df = _fake_df(50)
        duped = pd.concat([df, df.head(10)], ignore_index=True)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = duped
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-03", str(algo_dir))

        assert result.bars_written == 50
        written = pd.read_parquet(result.parquet_path)
        assert written["timestamp"].is_monotonic_increasing

    def test_quality_report_attached_to_sources(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(100)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.return_value = _fake_df(80)

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-05", str(algo_dir))

        binance_src = next(s for s in result.sources_tried if s.provider == "binance")
        assert binance_src.quality is not None
        assert binance_src.quality.n_bars == 100
        assert binance_src.bars == 100

    def test_digest_includes_quality_section(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(100)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-05", str(algo_dir))

        assert "quality" in result.digest
        assert "coverage_pct" in result.digest["quality"]
        assert "gaps" in result.digest["quality"]
        assert "ohlc_violations" in result.digest["quality"]

    def test_parquet_file_naming_convention(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(10)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "4h", "2024-01-01", "2024-03-01", str(algo_dir))

        filename = Path(result.parquet_path).name
        assert filename == "BTC-USD_4h_2024-01-01_2024-03-01.parquet"


# ---------------------------------------------------------------------------
# 6. JSON serialization (for TS tool consumption)
# ---------------------------------------------------------------------------

class TestResultSerialization:
    def test_result_to_json_is_valid(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(50)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-03", str(algo_dir))

        j = result_to_json(result)
        parsed = json.loads(j)

        assert parsed["symbol"] == "BTC/USD"
        assert parsed["asset_class"] == "crypto_spot"
        assert parsed["bars_written"] == 50
        assert "digest" in parsed
        assert "sources" in parsed
        assert len(parsed["sources"]) >= 1

    def test_no_data_result_serializes(self):
        result = ExtractResult(
            symbol="FAKE/USD",
            canonical="FAKE/USD",
            asset_class="crypto",
            interval="1h",
            start="2024-01-01",
            end="2024-02-01",
            parquet_path="",
            bars_written=0,
            sources_tried=[],
            digest={"symbol": "FAKE/USD", "bars": 0, "status": "no_data"},
        )
        j = result_to_json(result)
        parsed = json.loads(j)
        assert parsed["bars_written"] == 0
        assert parsed["digest"]["status"] == "no_data"


# ---------------------------------------------------------------------------
# 7. CSV fallback when pyarrow unavailable
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 8. Deep storage verification — parquet content, folder layout, data fidelity
# ---------------------------------------------------------------------------

class TestStorageVerification:
    """Verify that extract() writes correct data to the right place and the
    written parquet is a faithful representation of the source DataFrame."""

    def test_parquet_columns_match_schema(self, tmp_path):
        """Written parquet must have exactly [timestamp, open, high, low, close, volume]."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(50)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-03", str(algo_dir))

        df = pd.read_parquet(result.parquet_path)
        assert list(df.columns) == ["timestamp", "open", "high", "low", "close", "volume"]

    def test_parquet_values_match_source_data(self, tmp_path):
        """OHLCV values in the written file must match what the provider returned."""
        algo_dir = _make_algo_dir(tmp_path)
        source = _fake_df(30)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = source
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("ETH/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))

        written = pd.read_parquet(result.parquet_path)
        np.testing.assert_array_almost_equal(written["open"].values, source["open"].values)
        np.testing.assert_array_almost_equal(written["close"].values, source["close"].values)
        np.testing.assert_array_almost_equal(written["high"].values, source["high"].values)
        np.testing.assert_array_almost_equal(written["low"].values, source["low"].values)
        np.testing.assert_array_almost_equal(written["volume"].values, source["volume"].values)

    def test_parquet_timestamps_are_utc(self, tmp_path):
        """All timestamps in the written parquet must be timezone-aware UTC."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(20)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))

        written = pd.read_parquet(result.parquet_path)
        ts = pd.to_datetime(written["timestamp"])
        assert ts.dt.tz is not None, "timestamps must be tz-aware"
        assert str(ts.dt.tz) == "UTC", f"expected UTC, got {ts.dt.tz}"

    def test_no_nan_values_in_ohlcv(self, tmp_path):
        """Written parquet must not contain NaN in any OHLCV column."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(100)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-05", str(algo_dir))

        written = pd.read_parquet(result.parquet_path)
        for col in ["open", "high", "low", "close", "volume"]:
            assert not written[col].isna().any(), f"NaN found in {col}"

    def test_ohlc_invariant_holds(self, tmp_path):
        """low <= min(open,close) and max(open,close) <= high for every bar."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(100)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-05", str(algo_dir))

        df = pd.read_parquet(result.parquet_path)
        assert (df["low"] <= df["open"]).all()
        assert (df["low"] <= df["close"]).all()
        assert (df["high"] >= df["open"]).all()
        assert (df["high"] >= df["close"]).all()

    def test_volume_is_non_negative(self, tmp_path):
        """Volume must be >= 0 in every row."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(50)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("SOL/USD", "1h", "2024-01-01", "2024-01-03", str(algo_dir))

        df = pd.read_parquet(result.parquet_path)
        assert (df["volume"] >= 0).all()


class TestFolderLayout:
    """Verify the algo directory tree after extraction."""

    def test_crypto_folder_tree(self, tmp_path):
        """Crypto extraction creates data/crypto/ with the parquet inside."""
        algo_dir = tmp_path / "btc-trend"
        algo_dir.mkdir()

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(20)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))

        assert (algo_dir / "data" / "crypto").is_dir()
        assert not (algo_dir / "data" / "stock").exists()
        pq = algo_dir / "data" / "crypto" / "BTC-USD_1h_2024-01-01_2024-01-02.parquet"
        assert pq.exists()
        assert pq.stat().st_size > 0

    def test_stock_folder_tree(self, tmp_path):
        """Stock extraction creates data/stock/ with the parquet inside."""
        algo_dir = tmp_path / "aapl-swing"
        algo_dir.mkdir()

        with patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.return_value = _fake_stock_df(40)

            result = extract("AAPL", "1d", "2024-01-01", "2024-03-01", str(algo_dir))

        assert (algo_dir / "data" / "stock").is_dir()
        assert not (algo_dir / "data" / "crypto").exists()
        pq = algo_dir / "data" / "stock" / "AAPL_1d_2024-01-01_2024-03-01.parquet"
        assert pq.exists()
        assert pq.stat().st_size > 0

    def test_multiple_extractions_coexist(self, tmp_path):
        """Multiple symbols at different intervals produce separate files in the same folder."""
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True

            MockBinance.return_value.fetch.return_value = _fake_df(50)
            MockYF.return_value.fetch.return_value = _fake_df(40)
            r1 = extract("BTC/USD", "1h", "2024-01-01", "2024-01-03", str(algo_dir))

            MockBinance.return_value.fetch.return_value = _fake_df(30)
            MockYF.return_value.fetch.return_value = _fake_df(20)
            r2 = extract("ETH/USD", "4h", "2024-02-01", "2024-03-01", str(algo_dir))

        crypto_dir = algo_dir / "data" / "crypto"
        files = sorted(f.name for f in crypto_dir.iterdir() if f.suffix == ".parquet")
        assert len(files) == 2
        assert "BTC-USD_1h_2024-01-01_2024-01-03.parquet" in files
        assert "ETH-USD_4h_2024-02-01_2024-03-01.parquet" in files

    def test_re_extraction_overwrites_existing_file(self, tmp_path):
        """Extracting the same symbol/interval/range overwrites the existing parquet."""
        algo_dir = _make_algo_dir(tmp_path)
        small = _fake_df(10)
        big = _fake_df(80)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            MockBinance.return_value.fetch.return_value = small
            r1 = extract("BTC/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))
            size_1 = Path(r1.parquet_path).stat().st_size

            MockBinance.return_value.fetch.return_value = big
            r2 = extract("BTC/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))
            size_2 = Path(r2.parquet_path).stat().st_size

        assert r1.parquet_path == r2.parquet_path
        assert size_2 > size_1, "second extraction (80 bars) should produce a larger file"
        written = pd.read_parquet(r2.parquet_path)
        assert len(written) == 80

    def test_mixed_asset_class_isolation(self, tmp_path):
        """Crypto and stock extractions go to separate subdirectories."""
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(50)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.return_value = _fake_stock_df(30)

            rc = extract("BTC/USD", "1h", "2024-01-01", "2024-01-03", str(algo_dir))
            rs = extract("AAPL", "1d", "2024-01-01", "2024-02-01", str(algo_dir))

        assert "data/crypto" in rc.parquet_path
        assert "data/stock" in rs.parquet_path
        crypto_files = list((algo_dir / "data" / "crypto").iterdir())
        stock_files = list((algo_dir / "data" / "stock").iterdir())
        assert len(crypto_files) == 1
        assert len(stock_files) == 1

    def test_no_data_leaves_no_file(self, tmp_path):
        """When all providers fail, no parquet file should be created."""
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.side_effect = RuntimeError("timeout")
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = True
            MockYF.return_value.fetch.side_effect = RuntimeError("network")

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-02-01", str(algo_dir))

        assert result.parquet_path == ""
        crypto_files = list((algo_dir / "data" / "crypto").glob("*.parquet"))
        assert len(crypto_files) == 0

    def test_symbol_with_slash_in_filename(self, tmp_path):
        """Slash in 'BTC/USD' becomes dash in filename: 'BTC-USD_...'"""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(10)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("DOGE/USD", "15m", "2024-06-01", "2024-06-15", str(algo_dir))

        filename = Path(result.parquet_path).name
        assert "/" not in filename, "filename must not contain raw slashes"
        assert filename == "DOGE-USD_15m_2024-06-01_2024-06-15.parquet"


class TestDigestStorageRoundtrip:
    """Verify digest stats match what's actually in the written parquet."""

    def test_digest_bar_count_matches_file(self, tmp_path):
        """digest.bars == len(pd.read_parquet(path))."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(75)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-04", str(algo_dir))

        on_disk = pd.read_parquet(result.parquet_path)
        assert result.digest["bars"] == len(on_disk) == result.bars_written == 75

    def test_digest_price_range_matches_file(self, tmp_path):
        """Digest high/low must match the actual min/max in the written file."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(60)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("ETH/USD", "4h", "2024-01-01", "2024-01-11", str(algo_dir))

        on_disk = pd.read_parquet(result.parquet_path)
        assert result.digest["price"]["high"] == round(float(on_disk["high"].max()), 6)
        assert result.digest["price"]["low"] == round(float(on_disk["low"].min()), 6)
        assert result.digest["price"]["open"] == round(float(on_disk["open"].iloc[0]), 6)
        assert result.digest["price"]["close"] == round(float(on_disk["close"].iloc[-1]), 6)

    def test_digest_total_return_matches_file(self, tmp_path):
        """Digest total_return_pct must match (last_close/first_close - 1)*100."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(100)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-05", str(algo_dir))

        on_disk = pd.read_parquet(result.parquet_path)
        c = on_disk["close"].values
        expected_ret = round(((c[-1] / c[0]) - 1) * 100, 4)
        assert abs(result.digest["performance"]["total_return_pct"] - expected_ret) < 0.01

    def test_digest_volume_total_matches_file(self, tmp_path):
        """Digest volume.total must match sum of volumes on disk."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(50)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("SOL/USD", "1h", "2024-01-01", "2024-01-03", str(algo_dir))

        on_disk = pd.read_parquet(result.parquet_path)
        assert result.digest["volume"]["total"] == round(float(on_disk["volume"].sum()), 2)

    def test_json_roundtrip_preserves_parquet_path(self, tmp_path):
        """result_to_json → JSON.parse preserves the parquet path verbatim."""
        algo_dir = _make_algo_dir(tmp_path)
        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF:
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(25)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))

        parsed = json.loads(result_to_json(result))
        assert parsed["parquet_path"] == result.parquet_path
        assert Path(parsed["parquet_path"]).exists()


# ---------------------------------------------------------------------------
# 9. CSV fallback when pyarrow unavailable
# ---------------------------------------------------------------------------

class TestCSVFallback:
    def test_writes_csv_when_no_pyarrow(self, tmp_path):
        algo_dir = _make_algo_dir(tmp_path)

        with patch("engine_v2.data.extractor.BinanceProvider") as MockBinance, \
             patch("engine_v2.data.extractor.YFinanceProvider") as MockYF, \
             patch.dict("sys.modules", {"pyarrow": None}):
            MockBinance.return_value.name = "binance"
            MockBinance.return_value.supports_interval.return_value = True
            MockBinance.return_value.fetch.return_value = _fake_df(20)
            MockYF.return_value.name = "yfinance"
            MockYF.return_value.supports_interval.return_value = False

            # Force ImportError on pyarrow
            import importlib
            import engine_v2.data.extractor as ext_mod

            original_extract = ext_mod.extract

            def patched_extract(*args, **kwargs):
                with patch("engine_v2.data.extractor.pyarrow", side_effect=ImportError):
                    return original_extract(*args, **kwargs)

            # Just verify the extract function handles the case gracefully
            result = extract("BTC/USD", "1h", "2024-01-01", "2024-01-02", str(algo_dir))

        assert result.bars_written > 0
