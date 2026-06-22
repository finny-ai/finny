"""Walk-forward IS/OOS harness + Deflated/Probabilistic Sharpe.

DSR/PSR are computed here because the tested model count is known here.
Folds are observations, not multiple-testing trials; parameter combinations
are trials.
"""

from __future__ import annotations

import inspect
import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

EULER_MASCHERONI = 0.5772156649015329


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_ppf(p: float) -> float:
    if p <= 0.0 or p >= 1.0:
        return 0.0
    try:
        from scipy.stats import norm
        return float(norm.ppf(p))
    except ImportError:
        a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
        b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01]
        q = p - 0.5
        r = q * q
        return float((((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q
                     / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1.0))


@dataclass
class Fold:
    fold: int
    train_start_ns: int
    train_end_ns: int
    test_start_ns: int
    test_end_ns: int
    is_sharpe: float
    oos_sharpe: float
    is_return: float
    oos_return: float
    oos_trades: int = 0
    oos_bars: int = 0
    oos_coverage: float = 0.0
    oos_max_drawdown: float = 0.0
    ruined: bool = False
    selected_params: Optional[Dict[str, Any]] = None


@dataclass
class WalkForwardResult:
    n_folds: int
    is_sharpe_mean: float
    oos_sharpe_mean: float
    oos_decay: float
    is_to_oos_sharpe_change: float
    flag_threshold: float
    flagged: bool
    deflated_sharpe: float
    probabilistic_sharpe: float
    stitched_oos_return: float = 0.0
    stitched_oos_sharpe: float = 0.0
    stitched_oos_trades: int = 0
    stitched_oos_bars: int = 0
    stitched_oos_coverage: float = 0.0
    ruined_folds: int = 0
    multiple_testing_trials: int = 1
    folds: List[Fold] = field(default_factory=list)


def deflated_sharpe(sharpe_hat: float, t: int, skew: float, ex_kurt: float,
                    trials: int) -> float:
    if trials <= 1 or t < 2:
        return probabilistic_sharpe(sharpe_hat, t, skew, ex_kurt, sr_benchmark=0.0)
    sr_b = (1.0 - EULER_MASCHERONI) * _norm_ppf(1.0 - 1.0 / trials) \
        + EULER_MASCHERONI * _norm_ppf(1.0 - 1.0 / (trials * math.e))
    return probabilistic_sharpe(sharpe_hat, t, skew, ex_kurt, sr_benchmark=sr_b)


def probabilistic_sharpe(sharpe_hat: float, t: int, skew: float, ex_kurt: float,
                          sr_benchmark: float = 0.0) -> float:
    if t < 2:
        return 0.0
    denom = 1.0 - skew * sharpe_hat + (ex_kurt - 1.0) / 4.0 * (sharpe_hat ** 2)
    denom = max(denom, 1e-12)
    z = (sharpe_hat - sr_benchmark) * math.sqrt(t - 1) / math.sqrt(denom)
    return float(_norm_cdf(z))


def _runner_accepts_eval_window(runner: Callable[..., Dict[str, Any]]) -> bool:
    try:
        sig = inspect.signature(runner)
    except (TypeError, ValueError):
        return False
    positional = [
        p for p in sig.parameters.values()
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    return len(positional) >= 4


def _expected_oos_return_bars(train_end: int, test_end: int) -> int:
    """Return-observation count for an OOS window (equity points minus one)."""
    return max(0, test_end - train_end - 1)


def _candidate_score(result: Dict[str, Any]) -> Tuple[float, float, int]:
    return (
        float(result.get("sharpe", 0.0)),
        float(result.get("total_return", 0.0)),
        int(result.get("trades", 0) or 0),
    )


def _select_in_sample_params(
    call_runner: Callable[[int, int, int, Optional[Dict[str, Any]]], Dict[str, Any]],
    warm_train_start: int,
    train_end: int,
    start: int,
    tested_params: List[Optional[Dict[str, Any]]],
    optimize: bool,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    best_params = tested_params[0]
    best_res = call_runner(warm_train_start, train_end, start, best_params)
    if not optimize:
        return best_params, best_res

    best_score = _candidate_score(best_res)
    for candidate in tested_params[1:]:
        candidate_res = call_runner(warm_train_start, train_end, start, candidate)
        if _candidate_score(candidate_res) > best_score:
            best_params = candidate
            best_res = candidate_res
            best_score = _candidate_score(candidate_res)
    return best_params, best_res


def _fold_from_oos_result(
    *,
    fold_idx: int,
    ts_ns: np.ndarray,
    start: int,
    train_end: int,
    test_end: int,
    is_res: Dict[str, Any],
    oos_res: Dict[str, Any],
    best_params: Optional[Dict[str, Any]],
    expected_oos_bars: int,
) -> Fold:
    oos_returns = np.asarray(oos_res.get("returns", np.zeros(0)), dtype=float)
    oos_bars = int(oos_res.get("bars", oos_returns.size) or 0)
    coverage = float(oos_bars / max(1, expected_oos_bars))
    min_equity = float(oos_res.get("min_equity", 1.0))
    ruined = bool(oos_res.get("ruined", False) or min_equity <= 0.0)
    return Fold(
        fold=fold_idx,
        train_start_ns=int(ts_ns[start]),
        train_end_ns=int(ts_ns[train_end - 1]),
        test_start_ns=int(ts_ns[train_end]),
        test_end_ns=int(ts_ns[test_end - 1]),
        is_sharpe=float(is_res.get("sharpe", 0.0)),
        oos_sharpe=float(oos_res.get("sharpe", 0.0)),
        is_return=float(is_res.get("total_return", 0.0)),
        oos_return=float(oos_res.get("total_return", 0.0)),
        oos_trades=int(oos_res.get("trades", 0) or 0),
        oos_bars=oos_bars,
        oos_coverage=coverage,
        oos_max_drawdown=float(oos_res.get("max_drawdown", 0.0)),
        ruined=ruined,
        selected_params=dict(best_params) if isinstance(best_params, dict) else None,
    )


def _stitched_dsr_psr(
    stitched: np.ndarray,
    stitched_sharpe: float,
    trials: int,
) -> Tuple[float, float]:
    if stitched.size <= 2:
        return 0.0, 0.0
    from ..metrics import risk as RR
    sk = RR.skewness(stitched)
    kt = RR.kurtosis(stitched)
    ds = deflated_sharpe(stitched_sharpe, stitched.size, sk, kt, trials=trials)
    ps = probabilistic_sharpe(stitched_sharpe, stitched.size, sk, kt, sr_benchmark=0.0)
    return ds, ps


def run_walk_forward(
    full_runner: Callable[..., Dict[str, Any]],
    n_bars: int,
    ts_ns: np.ndarray,
    train_frac: float = 0.7,
    n_folds: int = 5,
    flag_threshold: float = 0.5,
    required_history_bars: int = 0,
    param_grid: Optional[List[Dict[str, Any]]] = None,
    bars_per_year: float = 252.0,
) -> WalkForwardResult:
    """Run rolling out-of-sample validation.

    The runner may accept either the legacy `(start_idx, end_idx)` signature or
    the robustness-aware `(warmup_start, end_idx, eval_start_idx, params)`.
    Metrics are computed only from `eval_start_idx:end_idx`; earlier bars are
    warm-up history for strategy state.
    """
    empty = WalkForwardResult(0, 0.0, 0.0, 0.0, 0.0, flag_threshold, False, 0.0, 0.0)
    if n_bars < 100 or n_folds < 2:
        return empty

    fold_size = n_bars // n_folds
    train_size = int(fold_size * train_frac)
    tested_params: List[Optional[Dict[str, Any]]] = list(param_grid) if param_grid else [None]
    use_eval_window = _runner_accepts_eval_window(full_runner)

    def call_runner(start_idx: int, end_idx: int, eval_start_idx: int, params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if use_eval_window:
            return full_runner(start_idx, end_idx, eval_start_idx, params)
        return full_runner(eval_start_idx, end_idx)

    folds: List[Fold] = []
    is_sharpes: List[float] = []
    oos_sharpes: List[float] = []
    oos_returns_all: List[np.ndarray] = []
    total_expected_oos_bars = 0
    history = max(0, required_history_bars)
    optimize = param_grid is not None

    for f in range(n_folds):
        start = f * fold_size
        train_end = start + train_size
        test_end = min(n_bars, start + fold_size)
        if train_end >= test_end:
            continue

        expected_oos_bars = _expected_oos_return_bars(train_end, test_end)
        total_expected_oos_bars += expected_oos_bars
        warm_train_start = max(0, start - history)
        best_params, is_res = _select_in_sample_params(
            call_runner, warm_train_start, train_end, start, tested_params, optimize,
        )
        warm_test_start = max(0, train_end - history)
        oos_res = call_runner(warm_test_start, test_end, train_end, best_params)
        fold = _fold_from_oos_result(
            fold_idx=f,
            ts_ns=ts_ns,
            start=start,
            train_end=train_end,
            test_end=test_end,
            is_res=is_res,
            oos_res=oos_res,
            best_params=best_params,
            expected_oos_bars=expected_oos_bars,
        )
        folds.append(fold)
        is_sharpes.append(fold.is_sharpe)
        oos_sharpes.append(fold.oos_sharpe)
        oos_returns_all.append(np.asarray(oos_res.get("returns", np.zeros(0)), dtype=float))

    if not folds:
        return empty

    is_mean = float(np.mean(is_sharpes))
    oos_mean = float(np.mean(oos_sharpes))
    decay = float(oos_mean / is_mean) if abs(is_mean) > 1e-9 else 0.0
    abs_change = float(oos_mean - is_mean)
    flagged = decay < flag_threshold
    stitched = np.concatenate(oos_returns_all) if oos_returns_all else np.zeros(0)
    stitched_ret = float(np.prod(1.0 + stitched) - 1.0) if stitched.size else 0.0
    from ..metrics import ratios as RAT
    stitched_sharpe = RAT.sharpe(stitched, bars_per_year=bars_per_year) if stitched.size else 0.0
    trials = max(1, len(tested_params))
    ds, ps = _stitched_dsr_psr(stitched, stitched_sharpe, trials)
    stitched_oos_bars = sum(fold.oos_bars for fold in folds)

    return WalkForwardResult(
        n_folds=len(folds),
        is_sharpe_mean=is_mean,
        oos_sharpe_mean=oos_mean,
        oos_decay=decay,
        is_to_oos_sharpe_change=abs_change,
        flag_threshold=flag_threshold,
        flagged=flagged,
        deflated_sharpe=ds,
        probabilistic_sharpe=ps,
        stitched_oos_return=stitched_ret,
        stitched_oos_sharpe=stitched_sharpe,
        stitched_oos_trades=sum(fold.oos_trades for fold in folds),
        stitched_oos_bars=stitched_oos_bars,
        stitched_oos_coverage=float(stitched_oos_bars / max(1, total_expected_oos_bars)),
        ruined_folds=sum(1 for fold in folds if fold.ruined),
        multiple_testing_trials=trials,
        folds=folds,
    )
