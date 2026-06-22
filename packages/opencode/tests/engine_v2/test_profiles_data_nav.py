from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np
import pandas as pd
import pytest

from engine_v2.assets import resolve_asset_spec
from engine_v2.core.arrays import BarArrays, MarketSnapshot
from engine_v2.data import quality as DQ
from engine_v2.data.extractor import _roll_adjust_futures
from engine_v2.execution.costs import CostConfig
from engine_v2.execution.fills import FillConfig
from engine_v2.execution.orders import Order
from engine_v2.execution.profiles import resolve_execution_profile
from engine_v2.execution.slippage import SlippageConfig
from engine_v2.portfolio.account import Account
from engine_v2.runtime.broker import PortfolioBroker


def _bars(*ohlcv) -> BarArrays:
    o = np.array([row[0] for row in ohlcv], dtype=np.float64)
    h = np.array([row[1] for row in ohlcv], dtype=np.float64)
    lows = np.array([row[2] for row in ohlcv], dtype=np.float64)
    c = np.array([row[3] for row in ohlcv], dtype=np.float64)
    v = np.array([row[4] for row in ohlcv], dtype=np.float64)
    ts = np.arange(len(o), dtype=np.int64) * 60_000_000_000
    return BarArrays(symbol="X", ts=ts, open=o, high=h, low=lows, close=c, volume=v, atr=np.ones(len(o)))


def test_execution_profile_defaults_disable_atr_and_emit_scenarios():
    state = resolve_execution_profile("equity", {})
    assert state["profile"]["id"] == "liquid_us_equity_v1"
    assert state["profile_defaults"]["k_atr"] == 0.0
    assert state["effective"]["k_atr"] == 0.0
    assert state["scenarios"]["zero_cost"]["slippage_bps"] == 0.0
    assert state["scenarios"]["base"]["k_atr"] == 0.0
    assert state["scenarios"]["stressed"]["k_atr"] > 0.0


def test_execution_profile_overrides_do_not_change_identity():
    state = resolve_execution_profile("crypto_spot", {"profile_id": "crypto_spot_v1", "slippage_bps": 9.0})
    assert state["profile"]["id"] == "crypto_spot_v1"
    assert state["profile_defaults"]["slippage_bps"] != 9.0
    assert state["effective"]["slippage_bps"] == 9.0
    assert state["overrides"] == {"slippage_bps": 9.0}
    with pytest.raises(ValueError, match="not crypto_spot"):
        resolve_execution_profile("crypto_spot", {"profile_id": "liquid_us_equity_v1"})


def test_symbol_asset_class_mismatch_requires_complete_custom_spec():
    with pytest.raises(ValueError, match="inconsistent"):
        resolve_asset_spec({"symbol": "BTC-USD", "asset_class": "equity"})
    spec = resolve_asset_spec({
        "symbol": "BTC-USD",
        "asset_class": "equity",
        "asset_spec": {
            "tickSize": 0.01,
            "lotSize": 1,
            "multiplier": 1,
            "calendar": "US_EQUITIES",
            "currency": "USD",
            "feeModel": "custom",
            "marginModel": "custom",
            "dataProvider": "custom",
        },
    })
    assert spec.assetClass == "equity"


def test_exchange_calendar_coverage_flags_truncated_equity_window():
    ts = pd.date_range("2024-01-02 14:30", periods=10, freq="15min", tz="UTC")
    rows = pd.DataFrame({
        "timestamp": ts,
        "open": np.full(len(ts), 100.0),
        "high": np.full(len(ts), 101.0),
        "low": np.full(len(ts), 99.0),
        "close": np.full(len(ts), 100.0),
        "volume": np.full(len(ts), 1000.0),
    })
    report = DQ.analyze(rows, "15min", "equity", provider="test")
    assert report.coverage_pct < 1.0
    assert any("coverage" in reason for reason in DQ.blocking_reasons(report, "equity"))


def test_terminal_liquidation_nav_cancels_pending_and_closes_positions():
    ba = _bars((100, 100, 100, 100, 1_000_000), (100, 100, 100, 100, 1_000_000))
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=10.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0, slippage=SlippageConfig(base_bps=10.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    snap.set_index(0)
    broker.submit_order(Order(id="entry", symbol="X", side="buy", qty=10, order_type="market"))
    broker.process_bar(1)
    broker.submit_order(Order(id="pending", symbol="X", side="buy", qty=1, order_type="market"))
    terminal = broker.terminal_liquidation_nav()
    assert terminal["canceled_pending_orders"] == 1
    assert len(terminal["hypothetical_closes"]) == 1
    assert terminal["nav"] < broker.get_equity()


def test_exchange_calendar_coverage_flags_truncated_equity_window():
    ts = pd.date_range("2024-01-02 14:30", periods=10, freq="15min", tz="UTC")
    rows = pd.DataFrame({
        "timestamp": ts,
        "open": np.full(len(ts), 100.0),
        "high": np.full(len(ts), 101.0),
        "low": np.full(len(ts), 99.0),
        "close": np.full(len(ts), 100.0),
        "volume": np.full(len(ts), 1000.0),
    })
    report = DQ.analyze(rows, "15min", "equity", provider="test")
    assert report.coverage_pct < 1.0
    assert any("coverage" in reason for reason in DQ.blocking_reasons(report, "equity"))


def test_exchange_calendar_coverage_accepts_full_single_session():
    ts = pd.date_range("2024-01-02 14:30", periods=26, freq="15min", tz="UTC")
    rows = pd.DataFrame({
        "timestamp": ts,
        "open": np.full(len(ts), 100.0),
        "high": np.full(len(ts), 101.0),
        "low": np.full(len(ts), 99.0),
        "close": np.full(len(ts), 100.0),
        "volume": np.full(len(ts), 1000.0),
    })
    report = DQ.analyze(rows, "15min", "equity", provider="test")
    assert report.coverage_pct >= 0.95
    assert not any("coverage" in reason for reason in DQ.blocking_reasons(report, "equity"))


def test_requested_window_allows_weekend_start_for_equity():
    ts = pd.date_range("2024-01-08 14:30", periods=10, freq="15min", tz="UTC")
    rows = pd.DataFrame({
        "timestamp": ts,
        "open": np.full(len(ts), 100.0),
        "high": np.full(len(ts), 101.0),
        "low": np.full(len(ts), 99.0),
        "close": np.full(len(ts), 100.0),
        "volume": np.full(len(ts), 1000.0),
    })
    reasons = DQ.requested_window_reasons(
        rows, "15min", "equity", requested_start="2024-01-07", requested_end=None,
    )
    assert reasons == []


def _multi_roll_futures_rows() -> pd.DataFrame:
    rows = []
    ts = pd.date_range("2024-01-01", periods=80, freq="D", tz="UTC")
    for i, t in enumerate(ts):
        base = 100.0 + i
        volume = 1000.0
        if i >= 30:
            base += 20.0
            volume = 5000.0 if i == 30 else volume
        if i >= 60:
            base -= 15.0
            volume = 5000.0 if i == 60 else volume
        rows.append({
            "timestamp": t,
            "open": base,
            "high": base + 1,
            "low": base - 1,
            "close": base,
            "volume": volume,
        })
    return pd.DataFrame(rows)


def test_multi_roll_back_adjustment_validates_every_boundary():
    adjusted, boundaries = _roll_adjust_futures(_multi_roll_futures_rows())
    assert len(boundaries) >= 2
    for boundary in boundaries:
        i = boundary.index
        assert abs(float(adjusted.loc[i, "open"]) - float(adjusted.loc[i - 1, "close"])) < 1e-8
