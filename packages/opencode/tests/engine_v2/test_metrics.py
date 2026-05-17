"""Metric module golden-input tests."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.metrics import returns as R
from engine_v2.metrics import risk as Rsk
from engine_v2.metrics import ratios as Rat
from engine_v2.metrics import drawdown as DD
from engine_v2.metrics import trade as T
from engine_v2.metrics import stability as S
from engine_v2.metrics import benchmark as B
from engine_v2.portfolio.positions import ClosedTrade


def test_total_return_simple():
    eq = np.array([100.0, 110.0, 121.0])
    assert abs(R.total_return(eq) - 0.21) < 1e-9


def test_cagr_returns_none_for_short_window():
    eq = np.array([100.0, 110.0])
    ts = np.array([0, 86_400_000_000_000])   # 1 day
    assert R.cagr(eq, ts) is None


def test_cagr_one_year_double():
    eq = np.array([100.0, 200.0])
    ts = np.array([0, 365 * 86_400_000_000_000])
    c = R.cagr(eq, ts)
    assert c is not None and abs(c - 1.0) < 1e-6


def test_max_drawdown_basic():
    eq = np.array([100.0, 110.0, 80.0, 90.0, 120.0])
    mdd = DD.max_drawdown(eq)
    assert abs(mdd - (-0.2727272727272727)) < 1e-9   # 80/110 - 1


def test_sharpe_zero_volatility():
    r = np.array([0.001] * 100)
    assert Rat.sharpe(r, bars_per_year=252) == 0.0


def test_sharpe_positive_with_low_vol():
    rng = np.random.default_rng(0)
    r = 0.001 + rng.standard_normal(252) * 0.001
    s = Rat.sharpe(r, bars_per_year=252)
    assert s > 5.0   # high SNR


def test_var_cvar_ordering():
    rng = np.random.default_rng(0)
    r = rng.standard_normal(1000) * 0.01
    var95 = Rsk.value_at_risk(r, 0.95)
    var99 = Rsk.value_at_risk(r, 0.99)
    assert var99 > var95
    cvar95 = Rsk.conditional_var(r, 0.95)
    assert cvar95 >= var95


def test_omega_threshold_zero():
    r = np.array([0.01, 0.02, -0.005, -0.01, 0.005])
    om = Rat.omega(r, threshold=0.0)
    assert om > 0


def test_k_ratio_positive_on_linear_uptrend():
    eq = 100.0 * np.exp(np.linspace(0, 1, 200))
    k = Rat.k_ratio(eq)
    assert k > 50   # essentially infinite for noiseless line


def test_equity_r2_one_for_exponential_growth():
    eq = 100.0 * np.exp(np.linspace(0, 1, 200))
    assert abs(S.equity_r2(eq) - 1.0) < 1e-9


def test_trade_metrics_basic():
    trades = [
        ClosedTrade("X", "long", 0, 1, 10, 100, 110, pnl=100, fees=0, funding=0, borrow=0,
                    mae=0, mfe=100, hold_bars=5, entry_tag="a", exit_tag="b",
                    stop_distance=2.0),
        ClosedTrade("X", "long", 1, 2, 10, 110, 105, pnl=-50, fees=0, funding=0, borrow=0,
                    mae=50, mfe=0, hold_bars=3, entry_tag="a", exit_tag="b",
                    stop_distance=2.0),
        ClosedTrade("X", "long", 2, 3, 10, 105, 115, pnl=100, fees=0, funding=0, borrow=0,
                    mae=0, mfe=100, hold_bars=4, entry_tag="a", exit_tag="b",
                    stop_distance=None),
    ]
    m = T.compute(trades)
    assert m["total_trades"] == 3
    assert abs(m["win_rate"] - 2 / 3) < 1e-9
    assert abs(m["expectancy"] - 50.0) < 1e-9
    assert m["payoff_ratio"] > 1
    assert m["max_consecutive_wins"] == 1
    assert m["kelly_confidence"] == "low"
    # expectancy_r computed only from trades with stop_distance
    assert m["expectancy_r"] is not None


def test_benchmark_alpha_beta_on_correlated_series():
    rng = np.random.default_rng(0)
    b = rng.standard_normal(252) * 0.01
    s = 0.001 + 1.5 * b + rng.standard_normal(252) * 0.001
    out = B.compute(s, b, bars_per_year=252)
    assert out is not None
    assert abs(out["beta"] - 1.5) < 0.1
    assert out["correlation"] > 0.8
    assert out["alpha_annualized"] > 0   # we injected positive intercept


def test_rolling_sharpe_returns_finite():
    rng = np.random.default_rng(0)
    r = 0.0005 + rng.standard_normal(500) * 0.01
    mean, mn, mx = S.rolling_sharpe(r, bars_per_year=252, window=90)
    assert math.isfinite(mean) and math.isfinite(mn) and math.isfinite(mx)
    assert mn <= mean <= mx
