"""Walk-forward IS/OOS harness + Deflated/Probabilistic Sharpe.

This is the only place DSR/PSR are computed — `trials_n` is known here (it's
n_folds), unlike single-run backtests where the trial count is unknown and a
DSR would be misleading.

PSR formula (Bailey & López de Prado): for a realized Sharpe SR_hat over T
observations with skewness γ3 and excess kurtosis γ4, the probability that
the true Sharpe exceeds a benchmark SR_b is:

    PSR(SR_b) = Φ( (SR_hat - SR_b) * sqrt(T-1) /
                   sqrt(1 - γ3·SR_hat + (γ4-1)/4 · SR_hat²) )

DSR adjusts SR_b for multiple testing using the expected maximum of N
independent trials:

    SR_b* = (1 - γ_e) * Φ⁻¹(1 - 1/N) + γ_e * Φ⁻¹(1 - 1/(N·e))

with γ_e the Euler-Mascheroni constant. DSR = PSR(SR_b*).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import numpy as np

EULER_MASCHERONI = 0.5772156649015329


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_ppf(p: float) -> float:
    # Acklam's algorithm — close enough for our purposes; scipy.stats.norm.ppf
    # would be nicer but we want zero-dependency fallback.
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


@dataclass
class WalkForwardResult:
    n_folds: int
    is_sharpe_mean: float
    oos_sharpe_mean: float
    oos_decay: float
    flag_threshold: float
    flagged: bool
    deflated_sharpe: float
    probabilistic_sharpe: float
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


def run_walk_forward(
    full_runner: Callable[[int, int], Dict[str, Any]],
    n_bars: int,
    ts_ns: np.ndarray,
    train_frac: float = 0.7,
    n_folds: int = 5,
    flag_threshold: float = 0.5,
) -> WalkForwardResult:
    """`full_runner(start_idx, end_idx)` runs the engine on a slice and returns
    {'sharpe': ..., 'total_return': ..., 'returns': np.ndarray}.

    Folds are rolling: window = n_bars / n_folds; train on the first `train_frac`
    of each window, test on the remainder.
    """
    if n_bars < 100 or n_folds < 2:
        return WalkForwardResult(0, 0.0, 0.0, 0.0, flag_threshold, False, 0.0, 0.0, [])
    fold_size = n_bars // n_folds
    train_size = int(fold_size * train_frac)
    folds: List[Fold] = []
    is_sharpes, oos_sharpes = [], []
    oos_returns_all: List[np.ndarray] = []
    for f in range(n_folds):
        start = f * fold_size
        train_end = start + train_size
        test_end = min(n_bars, start + fold_size)
        if train_end >= test_end:
            continue
        is_res = full_runner(start, train_end)
        oos_res = full_runner(train_end, test_end)
        folds.append(Fold(
            fold=f, train_start_ns=int(ts_ns[start]), train_end_ns=int(ts_ns[train_end - 1]),
            test_start_ns=int(ts_ns[train_end]), test_end_ns=int(ts_ns[test_end - 1]),
            is_sharpe=float(is_res.get("sharpe", 0.0)),
            oos_sharpe=float(oos_res.get("sharpe", 0.0)),
            is_return=float(is_res.get("total_return", 0.0)),
            oos_return=float(oos_res.get("total_return", 0.0)),
        ))
        is_sharpes.append(folds[-1].is_sharpe)
        oos_sharpes.append(folds[-1].oos_sharpe)
        oos_returns_all.append(oos_res.get("returns", np.zeros(0)))
    if not folds:
        return WalkForwardResult(0, 0.0, 0.0, 0.0, flag_threshold, False, 0.0, 0.0, [])
    is_mean = float(np.mean(is_sharpes))
    oos_mean = float(np.mean(oos_sharpes))
    decay = float(oos_mean / is_mean) if abs(is_mean) > 1e-9 else 0.0
    flagged = decay < flag_threshold
    stitched = np.concatenate(oos_returns_all) if oos_returns_all else np.zeros(0)
    if stitched.size > 2:
        from ..metrics import risk as RR
        sk = RR.skewness(stitched)
        kt = RR.kurtosis(stitched)
        ds = deflated_sharpe(oos_mean, stitched.size, sk, kt, trials=len(folds))
        ps = probabilistic_sharpe(oos_mean, stitched.size, sk, kt, sr_benchmark=0.0)
    else:
        ds, ps = 0.0, 0.0
    return WalkForwardResult(
        n_folds=len(folds), is_sharpe_mean=is_mean, oos_sharpe_mean=oos_mean,
        oos_decay=decay, flag_threshold=flag_threshold, flagged=flagged,
        deflated_sharpe=ds, probabilistic_sharpe=ps, folds=folds,
    )
