"""Options support: symbols, synthetic bars, greeks, and option costs."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np
import pandas as pd

from engine_v2.assets import normalize_asset_class, resolve_asset_spec
from engine_v2.core.arrays import MarketSnapshot, from_dataframe
from engine_v2.data.providers.synthetic_options import SyntheticOptionsProvider
from engine_v2.execution.costs import CostConfig, commission
from engine_v2.options.greeks import greeks
from engine_v2.options.pricing import option_price
from engine_v2.options.symbols import is_option_symbol, make_option_symbol, parse_option_symbol


def test_option_symbol_roundtrip_and_asset_detection():
    symbol = make_option_symbol("spy", "20260619", 500.0, "c")

    assert symbol == "SPY/20260619/500C"
    assert is_option_symbol(symbol)
    spec = parse_option_symbol(symbol)
    assert spec.underlying == "SPY"
    assert spec.expiry == "20260619"
    assert spec.strike == 500.0
    assert spec.is_call
    assert normalize_asset_class(None, symbol) == "option"

    asset = resolve_asset_spec({"symbol": symbol})
    assert asset.assetClass == "option"
    assert asset.multiplier == 100.0
    assert asset.dataProvider == "synthetic_options"
    assert asset.productionEligible is True
    assert asset.blockingReason is None


def test_black_scholes_price_and_greeks_are_reasonable():
    price = option_price(100.0, 100.0, 30.0 / 365.0, 0.05, 0.25, "C")
    g = greeks(100.0, 100.0, 30.0 / 365.0, 0.05, 0.25, "C")

    assert 3.0 < price < 4.0
    assert 0.5 < g["delta"] < 0.6
    assert g["gamma"] > 0.0
    assert g["vega"] > 0.0
    assert g["theta"] < 0.0


class _FakeUnderlyingProvider:
    def supports_interval(self, interval: str) -> bool:
        return True

    def fetch(self, symbol: str, start: str, end: str, interval: str) -> pd.DataFrame:
        ts = pd.date_range("2026-01-02", periods=3, freq="1d", tz="UTC")
        return pd.DataFrame({
            "timestamp": ts,
            "open": [100.0, 102.0, 104.0],
            "high": [101.0, 103.0, 105.0],
            "low": [99.0, 101.0, 103.0],
            "close": [100.5, 102.5, 104.5],
            "volume": [1000.0, 1100.0, 1200.0],
        })


def test_synthetic_options_provider_emits_option_metadata():
    provider = SyntheticOptionsProvider(iv=0.2, risk_free_rate=0.01)
    provider._underlying_provider = _FakeUnderlyingProvider()

    df = provider.fetch("SPY/20260619/100C", "2026-01-02", "2026-01-05", "1d")

    assert list(df.columns) == [
        "timestamp", "open", "high", "low", "close", "volume",
        "underlying_close", "iv", "delta", "gamma", "theta", "vega",
    ]
    assert len(df) == 3
    assert np.all(df["close"].to_numpy() > 0.0)
    assert np.allclose(df["underlying_close"].to_numpy(), [100.5, 102.5, 104.5])
    assert np.allclose(df["iv"].to_numpy(), 0.2)
    assert np.all((df["delta"].to_numpy() > 0.0) & (df["delta"].to_numpy() < 1.0))


def test_decision_safe_option_bar_uses_previous_greeks():
    df = pd.DataFrame({
        "timestamp": pd.date_range("2026-01-02", periods=2, freq="1d", tz="UTC"),
        "open": [10.0, 11.0],
        "high": [10.5, 11.5],
        "low": [9.5, 10.5],
        "close": [10.2, 11.2],
        "volume": [100.0, 100.0],
        "underlying_close": [100.0, 120.0],
        "iv": [0.2, 0.4],
        "delta": [0.3, 0.8],
        "gamma": [0.01, 0.03],
        "theta": [-0.01, -0.04],
        "vega": [0.08, 0.18],
    })
    arrays = from_dataframe(df, "SPY/20260619/100C")
    snap = MarketSnapshot({"SPY/20260619/100C": arrays})
    snap.set_index(1)
    snap.set_decision_phase(True)

    try:
        bar = snap.decision_safe_bar("SPY/20260619/100C")
    finally:
        snap.set_decision_phase(False)

    assert bar["open"] == 11.0
    assert bar["underlying_close"] == 100.0
    assert bar["iv"] == 0.2
    assert bar["delta"] == 0.3
    assert bar["gamma"] == 0.01
    assert bar["theta"] == -0.01
    assert bar["vega"] == 0.08


def test_option_commission_is_per_contract_not_notional_bps():
    cfg = CostConfig(taker_fee_bps=100.0, option_per_contract_fee=0.65)

    assert abs(commission(5000.0, is_maker=False, cfg=cfg, asset_class="option", qty=3) - 1.95) < 1e-12
    assert commission(5000.0, is_maker=False, cfg=cfg, asset_class="equity", qty=3) == 50.0
