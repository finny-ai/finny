"""MC reproducibility, walk-forward folds, DSR sanity, regime classification."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.robustness.monte_carlo import trade_shuffle, block_bootstrap
from engine_v2.robustness.regime import classify_bars, breakdown
from engine_v2.robustness.walkforward import (
    deflated_sharpe, probabilistic_sharpe, run_walk_forward,
)


def test_trade_shuffle_reproducible():
    pnls = np.array([10.0, -5.0, 20.0, -8.0, 15.0, -2.0, 30.0, -10.0, 5.0, -3.0])
    a = trade_shuffle(pnls, 1000.0, 252.0, n_paths=200, seed=42)
    b = trade_shuffle(pnls, 1000.0, 252.0, n_paths=200, seed=42)
    assert a.final_equity_p50 == b.final_equity_p50
    assert a.max_dd_p95 == b.max_dd_p95
    assert a.sharpe_p50 == b.sharpe_p50


def test_block_bootstrap_returns_stable_distribution():
    rng = np.random.default_rng(0)
    rets = rng.standard_normal(500) * 0.01
    out = block_bootstrap(rets, 1000.0, 252.0, n_paths=200, seed=7)
    assert out.n_paths == 200
    assert out.final_equity_p5 < out.final_equity_p50 < out.final_equity_p95


def test_psr_high_for_strong_sharpe_low_for_weak():
    psr_strong = probabilistic_sharpe(2.0, 252, skew=0.0, ex_kurt=3.0)
    psr_weak = probabilistic_sharpe(0.1, 252, skew=0.0, ex_kurt=3.0)
    assert psr_strong > 0.95
    assert psr_weak < 0.95


def test_dsr_penalizes_many_trials():
    psr = probabilistic_sharpe(1.5, 252, skew=0.0, ex_kurt=3.0)
    dsr_few = deflated_sharpe(1.5, 252, skew=0.0, ex_kurt=3.0, trials=2)
    dsr_many = deflated_sharpe(1.5, 252, skew=0.0, ex_kurt=3.0, trials=1000)
    assert psr >= dsr_few >= dsr_many


def test_regime_classification_three_buckets():
    rng = np.random.default_rng(0)
    n = 500
    # First half low-vol, second half high-vol
    seg1 = np.cumsum(rng.standard_normal(n // 2) * 0.001) + 100
    seg2 = np.cumsum(rng.standard_normal(n // 2) * 0.05) + seg1[-1]
    close = np.concatenate([seg1, seg2])
    labels = classify_bars(close, lookback=30)
    assert (labels == 0).sum() > 0   # low_vol bars
    assert (labels == 2).sum() > 0   # high_vol bars


def test_monte_carlo_zero_paths_returns_safely():
    out = trade_shuffle(np.array([1.0, -1.0]), 1000.0, 252.0, n_paths=0, seed=1)
    assert out.n_paths == 0


def test_walk_forward_decay_flag():
    ts = np.arange(1000, dtype=np.int64) * 86_400_000_000_000

    def runner(start: int, end: int) -> dict:
        # Synthetic: high IS sharpe (1.5), low OOS (0.2)
        is_marker = end - start
        if is_marker > 100:   # called for IS
            return {"sharpe": 1.5, "total_return": 0.2,
                    "returns": np.full(is_marker, 0.005)}
        return {"sharpe": 0.2, "total_return": 0.02,
                "returns": np.full(is_marker, 0.0005)}

    wf = run_walk_forward(runner, n_bars=1000, ts_ns=ts, train_frac=0.7,
                          n_folds=5, flag_threshold=0.5)
    assert wf.n_folds == 5
    assert wf.oos_decay < 0.5
    assert wf.flagged is True
