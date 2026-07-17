"""Strategy durability and consistency labels for engine_v2 reports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

import numpy as np

from . import ratios as M_ratios
from . import returns as M_returns
from . import stability as M_stability

CONSISTENT_R2_MIN = 0.8
CONSISTENT_POSITIVE_PERIODS_MIN = 0.55
CONSISTENT_ROLLING_SHARPE_MIN = -0.5
CONSISTENT_FOLD_ICIR_MIN = 0.5
STREAK_TOP_PERIOD_SHARE = 0.6
STREAK_MAX_LOSING_PERIODS = 4
STREAK_POSITIVE_PERIODS_MIN = 0.45


@dataclass(frozen=True)
class ConsistencyInput:
    equity: np.ndarray
    ts_ns: np.ndarray
    returns: np.ndarray
    bars_per_year: float
    walk_forward: Optional[Any]
    rolling_sharpe: Optional[np.ndarray] = None


def _fold_icir(walk_forward: Optional[Any]) -> Optional[float]:
    folds = getattr(walk_forward, "folds", None)
    if not folds:
        return None
    values = [
        float(getattr(f, "oos_sharpe"))
        for f in folds
        if getattr(f, "oos_sharpe", None) is not None and np.isfinite(float(getattr(f, "oos_sharpe")))
    ]
    if len(values) < 3:
        return None
    arr = np.asarray(values, dtype=np.float64)
    sd = float(arr.std(ddof=1))
    if sd <= 1e-12:
        return None
    return float(arr.mean() / sd)


def _period_rule(equity: np.ndarray, ts_ns: np.ndarray) -> tuple[Optional[str], int]:
    monthly = M_returns._resample_returns(equity, ts_ns, "1ME")
    if len(monthly) >= 6:
        return "1ME", int(len(monthly))
    weekly = M_returns._resample_returns(equity, ts_ns, "1W")
    if len(weekly) >= 8:
        return "1W", int(len(weekly))
    return None, int(max(len(monthly), len(weekly)))


@dataclass(frozen=True)
class ConsistencyFacts:
    period_rule: Optional[str]
    n_periods: int
    pct_positive: Optional[float]
    losing_periods: Optional[int]
    top_share: Optional[float]
    fold_icir: Optional[float]
    r2: float
    k_ratio: float
    rolling_mean: Optional[float]
    rolling_min: Optional[float]
    rolling_max: Optional[float]
    total_return: float
    rolling_size: int


def _rolling_stats(rolling: np.ndarray) -> tuple[Optional[float], Optional[float], Optional[float]]:
    if rolling.size == 0:
        return None, None, None
    return float(rolling.mean()), float(rolling.min()), float(rolling.max())


def _build_facts(input: ConsistencyInput, rolling: np.ndarray) -> ConsistencyFacts:
    period_rule, n_periods = _period_rule(input.equity, input.ts_ns)
    rolling_mean, rolling_min, rolling_max = _rolling_stats(rolling)
    return ConsistencyFacts(
        period_rule=period_rule,
        n_periods=n_periods,
        pct_positive=M_returns.pct_positive_periods(input.equity, input.ts_ns, period_rule) if period_rule else None,
        losing_periods=M_stability.max_consecutive_negative_periods(input.equity, input.ts_ns, period_rule) if period_rule else None,
        top_share=M_stability.top_period_return_share(input.equity, input.ts_ns, period_rule) if period_rule else None,
        fold_icir=_fold_icir(input.walk_forward),
        r2=M_stability.equity_r2(input.equity),
        k_ratio=M_ratios.k_ratio(input.equity),
        rolling_mean=rolling_mean,
        rolling_min=rolling_min,
        rolling_max=rolling_max,
        total_return=M_returns.total_return(input.equity),
        rolling_size=int(rolling.size),
    )


def _insufficient_reasons(facts: ConsistencyFacts) -> list[str]:
    reasons: list[str] = []
    if facts.period_rule is None:
        reasons.append("insufficient monthly/weekly periods")
    if facts.rolling_size < 30:
        reasons.append("rolling Sharpe series has fewer than 30 points")
    return reasons


def _is_streak_dependent(facts: ConsistencyFacts) -> bool:
    if facts.top_share is not None and facts.top_share > STREAK_TOP_PERIOD_SHARE:
        return True
    if facts.losing_periods is not None and facts.losing_periods >= STREAK_MAX_LOSING_PERIODS:
        return True
    if facts.pct_positive is None:
        return False
    return facts.pct_positive < STREAK_POSITIVE_PERIODS_MIN and facts.total_return > 0


def _has_consistent_profile(facts: ConsistencyFacts) -> bool:
    if facts.pct_positive is None or facts.rolling_min is None:
        return False
    fold_ok = facts.fold_icir is None or facts.fold_icir >= CONSISTENT_FOLD_ICIR_MIN
    return all(
        [
            facts.r2 >= CONSISTENT_R2_MIN,
            facts.k_ratio > 0,
            facts.pct_positive >= CONSISTENT_POSITIVE_PERIODS_MIN,
            facts.rolling_min > CONSISTENT_ROLLING_SHARPE_MIN,
            fold_ok,
        ]
    )


def _label(facts: ConsistencyFacts, reasons: list[str]) -> str:
    if reasons:
        return "insufficient"
    if _is_streak_dependent(facts):
        return "streak_dependent"
    if _has_consistent_profile(facts):
        return "consistent"
    return "lumpy"


def _confidence(n_periods: int, walk_forward: Optional[Any]) -> str:
    n_folds = int(getattr(walk_forward, "n_folds", 0) or 0)
    if n_periods >= 12 and n_folds >= 5:
        return "high"
    if n_periods >= 6:
        return "medium"
    return "low"


def compute_consistency(input: ConsistencyInput) -> Optional[Dict[str, Any]]:
    if input.equity.size < 2:
        return None
    rolling = input.rolling_sharpe
    if rolling is None:
        rolling = M_stability.rolling_sharpe_series(input.returns, input.bars_per_year)
    facts = _build_facts(input, rolling)
    reasons = _insufficient_reasons(facts)
    return {
        "equity_curve_r2": float(facts.r2),
        "k_ratio": float(facts.k_ratio),
        "fold_icir": facts.fold_icir,
        "rolling_sharpe_mean": facts.rolling_mean,
        "rolling_sharpe_min": facts.rolling_min,
        "rolling_sharpe_max": facts.rolling_max,
        "period_rule": facts.period_rule,
        "pct_positive_periods": facts.pct_positive,
        "max_consecutive_losing_periods": facts.losing_periods,
        "top_period_return_share": facts.top_share,
        "n_periods": facts.n_periods,
        "label": _label(facts, reasons),
        "confidence": _confidence(facts.n_periods, input.walk_forward),
        "reasons": reasons,
    }
