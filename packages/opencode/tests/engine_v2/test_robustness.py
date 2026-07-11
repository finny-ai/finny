"""MC reproducibility, walk-forward folds, DSR sanity, regime classification."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.robustness.monte_carlo import trade_shuffle, block_bootstrap
from engine_v2.robustness.regime import classify_bars, breakdown
from engine_v2.robustness.walkforward import (
    deflated_sharpe, probabilistic_sharpe, run_walk_forward,
)
from engine_v2.metrics import returns as M_returns


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


def test_mc_equity_curve_includes_starting_point():
    """First-trade adverse moves should show up in max_dd. Without the
    starting-equity anchor, a single big-loss-first path would compute
    DD against the post-loss equity = 0."""
    pnls = np.array([-100.0, 200.0])   # big loss first, recover
    out = trade_shuffle(pnls, 1000.0, 252.0, n_paths=50, seed=1)
    # Worst-case (loss-first) path: equity 1000 -> 900 -> 1100, DD = -10%
    # If the curve didn't include the starting point, DD would be 0 for
    # that path (only one bar after the loss).
    assert out.max_dd_p99 < -0.05


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


def test_walk_forward_preloads_history_but_scores_eval_window_only():
    ts = np.arange(500, dtype=np.int64) * 86_400_000_000_000
    calls = []

    def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
        calls.append((start, end, eval_start))
        bars = max(0, end - eval_start - 1)
        return {
            "sharpe": 1.0,
            "total_return": 0.1,
            "returns": np.full(bars, 0.001) if bars else np.zeros(0),
            "bars": bars,
            "trades": bars,
            "min_equity": 100.0,
        }

    wf = run_walk_forward(runner, n_bars=500, ts_ns=ts, n_folds=5, required_history_bars=25)
    assert wf.stitched_oos_bars == sum(f.oos_bars for f in wf.folds)
    assert wf.stitched_oos_coverage == 1.0
    # Fold 1 train starts at 100 but receives 25 warm-up bars.
    assert any(start == 75 and eval_start == 100 for start, _end, eval_start in calls)


def test_walk_forward_grid_counts_combinations_not_folds_as_trials():
    ts = np.arange(500, dtype=np.int64) * 86_400_000_000_000
    grid = [{"period": 10}, {"period": 20}, {"period": 30}]

    def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
        period = (params or {}).get("period", 0)
        sharpe = 2.0 if period == 20 else 0.5
        bars = max(0, end - eval_start - 1)
        return {
            "sharpe": sharpe,
            "total_return": sharpe / 10.0,
            "returns": np.full(bars, 0.001 * sharpe) if bars else np.zeros(0),
            "bars": bars,
            "trades": bars,
            "min_equity": 100.0,
        }

    wf = run_walk_forward(runner, n_bars=500, ts_ns=ts, n_folds=5, param_grid=grid)
    assert wf.multiple_testing_trials == 3
    assert all(f.selected_params == {"period": 20} for f in wf.folds)


def test_walk_forward_includes_prior_unique_selections_and_deduplicated_replay():
    ts = np.arange(500, dtype=np.int64) * 86_400_000_000_000

    def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
        bars = max(0, end - eval_start - 1)
        return {
            "sharpe": 1.0,
            "total_return": 0.1,
            "returns": np.full(bars, 0.001) if bars else np.zeros(0),
            "bars": bars,
            "trades": bars,
            "min_equity": 100.0,
        }

    selected = run_walk_forward(
        runner,
        n_bars=500,
        ts_ns=ts,
        n_folds=5,
        prior_selection_trials=4,
        current_selection_trials=1,
    )
    assert selected.multiple_testing_trials == 5

    replay = run_walk_forward(
        runner,
        n_bars=500,
        ts_ns=ts,
        n_folds=5,
        prior_selection_trials=4,
        current_selection_trials=0,
    )
    assert replay.multiple_testing_trials == 4


def test_walk_forward_negative_is_sharpe_reports_absolute_change():
    ts = np.arange(500, dtype=np.int64) * 86_400_000_000_000

    def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
        is_slice = end - eval_start > 50
        sharpe = -0.5 if is_slice else 0.2
        bars = max(0, end - eval_start - 1)
        return {
            "sharpe": sharpe,
            "total_return": 0.01,
            "returns": np.full(bars, 0.001) if bars else np.zeros(0),
            "bars": bars,
            "trades": bars,
            "min_equity": 100.0,
        }

    wf = run_walk_forward(runner, n_bars=500, ts_ns=ts, n_folds=5)
    assert wf.oos_decay is None
    assert wf.flagged is True
    assert "nonpositive_is_sharpe" in wf.flag_reasons
    assert wf.is_to_oos_sharpe_change > 0.0


def test_walk_forward_negative_is_and_oos_cannot_form_a_positive_decay_ratio():
    ts = np.arange(500, dtype=np.int64) * 86_400_000_000_000

    def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
        is_slice = end - eval_start > 50
        sharpe = -0.5 if is_slice else -0.2
        bars = max(0, end - eval_start - 1)
        returns = np.full(bars, -0.001) if bars else np.zeros(0)
        return {
            "sharpe": sharpe,
            "total_return": float(np.prod(1.0 + returns) - 1.0) if bars else 0.0,
            "returns": returns,
            "bars": bars,
            "trades": bars,
            "min_equity": 90.0,
        }

    wf = run_walk_forward(runner, n_bars=500, ts_ns=ts, n_folds=5)

    assert wf.oos_decay is None
    assert wf.flagged is True
    assert "nonpositive_is_sharpe" in wf.flag_reasons
    assert "nonpositive_stitched_oos_return" in wf.flag_reasons
    assert "nonpositive_stitched_oos_sharpe" in wf.flag_reasons


def test_walk_forward_absolute_stitched_metrics_override_positive_fold_labels():
    ts = np.arange(500, dtype=np.int64) * 86_400_000_000_000

    def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
        is_slice = end - eval_start > 50
        sharpe = 1.2 if is_slice else 0.9
        bars = max(0, end - eval_start - 1)
        returns = np.full(bars, -0.001) if bars else np.zeros(0)
        return {
            "sharpe": sharpe,
            "total_return": float(np.prod(1.0 + returns) - 1.0) if bars else 0.0,
            "returns": returns,
            "bars": bars,
            "trades": bars,
            "min_equity": 90.0,
        }

    wf = run_walk_forward(runner, n_bars=500, ts_ns=ts, n_folds=5)

    assert wf.oos_decay == pytest.approx(0.75)
    assert wf.flagged is True
    assert "nonpositive_stitched_oos_return" in wf.flag_reasons
    assert "nonpositive_stitched_oos_sharpe" in wf.flag_reasons


def test_walk_forward_positive_absolute_profile_has_no_flag_reasons():
    ts = np.arange(500, dtype=np.int64) * 86_400_000_000_000

    def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
        is_slice = end - eval_start > 50
        sharpe = 1.2 if is_slice else 0.9
        bars = max(0, end - eval_start - 1)
        returns = np.resize(np.array([0.002, -0.001]), bars) if bars else np.zeros(0)
        return {
            "sharpe": sharpe,
            "total_return": float(np.prod(1.0 + returns) - 1.0) if bars else 0.0,
            "returns": returns,
            "bars": bars,
            "trades": bars,
            "min_equity": 100.0,
        }

    wf = run_walk_forward(runner, n_bars=500, ts_ns=ts, n_folds=5)

    assert wf.oos_decay == pytest.approx(0.75)
    assert wf.stitched_oos_return > 0.0
    assert wf.stitched_oos_sharpe > 0.0
    assert wf.flagged is False
    assert wf.flag_reasons == []


def test_walk_forward_insufficient_input_is_structurally_flagged():
    wf = run_walk_forward(
        lambda start, end: {},
        n_bars=50,
        ts_ns=np.arange(50, dtype=np.int64),
        n_folds=5,
    )

    assert wf.oos_decay is None
    assert wf.flagged is True
    assert wf.flag_reasons == ["insufficient_folds"]


def test_walk_forward_dsr_psr_invariant_to_annualization():
    """DSR/PSR must depend only on the per-bar OOS return distribution, not on
    the annualization factor. Regression for two bugs in the stitched path:
    (1) the annualized Sharpe was fed where a per-observation Sharpe is required,
    coupling the scores to bars_per_year and saturating them to ~1.0 intraday;
    (2) excess kurtosis was passed where the Bailey/LdP formula expects raw
    (Pearson) kurtosis. Both silently inflated PSR/DSR."""
    ts = np.arange(1000, dtype=np.int64) * 86_400_000_000_000

    def make_runner():
        def runner(start: int, end: int, eval_start: int, params: dict | None) -> dict:
            bars = max(0, end - eval_start - 1)
            if bars <= 0:
                return {"sharpe": 0.0, "total_return": 0.0, "returns": np.zeros(0),
                        "bars": 0, "trades": 0, "min_equity": 100.0}
            # Tiny positive per-bar edge (~0.02 Sharpe) with symmetric noise.
            noise = 0.01 * np.where(np.arange(bars) % 2 == 0, 1.0, -1.0)
            rets = 0.0002 + noise
            return {"sharpe": 0.5, "total_return": float(np.prod(1.0 + rets) - 1.0),
                    "returns": rets, "bars": bars, "trades": bars, "min_equity": 100.0}
        return runner

    wf_daily = run_walk_forward(make_runner(), n_bars=1000, ts_ns=ts, n_folds=5,
                                bars_per_year=252.0)
    wf_intraday = run_walk_forward(make_runner(), n_bars=1000, ts_ns=ts, n_folds=5,
                                   bars_per_year=35040.0)

    assert wf_daily.probabilistic_sharpe == pytest.approx(wf_intraday.probabilistic_sharpe)
    assert wf_daily.deflated_sharpe == pytest.approx(wf_intraday.deflated_sharpe)
    # A near-zero per-bar edge must NOT saturate PSR (the pre-fix bug pushed it ~1.0).
    assert 0.0 < wf_daily.probabilistic_sharpe < 0.95


def test_regime_classification_does_not_use_future_quantiles():
    low = np.linspace(100, 101, 120)
    high = 101 + np.cumsum(np.tile([1.0, -1.0], 120))
    labels = classify_bars(np.concatenate([low, high]), lookback=10)
    # Early low-vol bars cannot be classified using future high-vol data.
    assert np.all(labels[:40] == -1)
    assert (labels[150:] == 2).sum() > 0


def test_bar_returns_stop_when_equity_is_non_positive():
    returns = M_returns.bar_returns(np.array([100.0, 0.0, 50.0, -10.0, 10.0]))
    assert np.all(np.isfinite(returns))
    assert returns.tolist() == [-1.0]
