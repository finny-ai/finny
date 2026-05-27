from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pandas as pd

from engine_v2.assets import normalize_asset_class, resolve_asset_spec, to_yfinance_symbol
from engine_v2.data.extractor import _roll_adjust_futures
from engine_v2.execution.costs import CostConfig, commission
from engine_v2.portfolio.account import Account
from engine_v2.portfolio.positions import Position


def test_futures_roots_infer_future_and_map_to_yfinance():
    assert normalize_asset_class(None, "ES") == "future"
    assert normalize_asset_class(None, "NQ=F") == "future"
    assert to_yfinance_symbol("ES") == "ES=F"
    assert to_yfinance_symbol("ES/CONT") == "ES=F"


def test_futures_contract_specs_are_per_root():
    es = resolve_asset_spec({"symbol": "ES"})
    nq = resolve_asset_spec({"symbol": "NQ"})
    cl = resolve_asset_spec({"symbol": "CL"})

    assert es.assetClass == "future"
    assert es.multiplier == 50.0
    assert es.initialMarginPct == 0.05
    assert es.maintenanceMarginPct == 0.04
    assert nq.multiplier == 20.0
    assert cl.multiplier == 1000.0
    assert cl.tickSize == 0.01


def test_futures_commission_can_be_per_contract():
    cfg = CostConfig(taker_fee_bps=7.0, commission_per_contract=2.25)
    assert commission(500_000, is_maker=False, cfg=cfg, qty=3, asset_class="future") == 6.75
    assert commission(10_000, is_maker=False, cfg=cfg, qty=3, asset_class="equity") == 7.0


def test_futures_account_margin_uses_contract_spec():
    es = resolve_asset_spec({"symbol": "ES"})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0, maintenance_margin_pct=0.0)
    acct.asset_specs = {"ES": es}
    acct.mark_prices({"ES": 5000.0})
    positions = {"ES": Position(symbol="ES", qty=2.0, avg_price=5000.0, multiplier=es.multiplier)}
    assert acct.required_initial_margin(positions) == 25_000.0
    assert acct.free_margin(positions) == 75_000.0
    assert acct.maintenance_margin_pct_for_symbol("ES") == 0.04


def test_futures_roll_adjustment_detects_boundary_and_preserves_latest_prices():
    rows = []
    ts = pd.date_range("2024-01-01", periods=45, freq="D", tz="UTC")
    for i, t in enumerate(ts):
        if i < 30:
            base = 100.0 + i
            vol = 1000.0
        else:
            base = 112.0 + i
            vol = 5000.0 if i == 30 else 1200.0
        rows.append({
            "timestamp": t,
            "open": base,
            "high": base + 1.0,
            "low": base - 1.0,
            "close": base + 0.5,
            "volume": vol,
        })
    df = pd.DataFrame(rows)
    adjusted, boundaries = _roll_adjust_futures(df)
    assert len(boundaries) >= 1
    assert adjusted.iloc[-1]["close"] == df.iloc[-1]["close"]
    assert adjusted.iloc[0]["close"] != df.iloc[0]["close"]
