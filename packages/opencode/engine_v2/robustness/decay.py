"""Alpha-decay diagnostics for engine_v2 durability reports."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from ..portfolio.positions import ClosedTrade


@dataclass
class MannKendallResult:
    trend: str
    s: int
    z: Optional[float]
    p_value: Optional[float]
    n: int
    reason: Optional[str] = None


@dataclass
class FoldSlope:
    slope: float
    r_squared: float
    n: int


@dataclass
class BreakevenProjection:
    status: str
    months: Optional[float]
    slope: Optional[float]
    latest_gross_expectancy: Optional[float]
    per_trade_cost: Optional[float]
    n_months: int
    n_trades: int
    reason: Optional[str] = None


@dataclass(frozen=True)
class AlphaDecayInput:
    rolling_sharpe: np.ndarray
    ts_ns: np.ndarray
    walk_forward: Optional[Any]
    trades: List[ClosedTrade]
    exposure: Any
    window: int = 90


def _mann_kendall_s(x: np.ndarray) -> int:
    s = 0
    for k in range(x.size - 1):
        s += int(np.sign(x[k + 1:] - x[k]).sum())
    return int(s)


def _mann_kendall_variance(x: np.ndarray) -> float:
    n = int(x.size)
    _, counts = np.unique(x, return_counts=True)
    tie_sum = float(sum(c * (c - 1) * (2 * c + 5) for c in counts if c > 1))
    return (n * (n - 1) * (2 * n + 5) - tie_sum) / 18.0


def _z_score(s: int, var_s: float) -> float:
    if s > 0:
        return (s - 1) / math.sqrt(var_s)
    if s < 0:
        return (s + 1) / math.sqrt(var_s)
    return 0.0


def _trend_from_z(z: float, p_value: float) -> str:
    if p_value >= 0.05:
        return "no_trend"
    return "increasing" if z > 0 else "decreasing"


def mann_kendall(series: np.ndarray) -> MannKendallResult:
    """Mann-Kendall trend test on a daily-last rolling-Sharpe series.

    Callers should resample intraday rolling-Sharpe to daily last values before
    calling this function. That keeps the O(n^2) pair comparison bounded and
    reduces overlap autocorrelation from intraday rolling windows.
    """
    x = np.asarray(series, dtype=np.float64)
    x = x[np.isfinite(x)]
    n = int(x.size)
    if n < 30:
        return MannKendallResult("insufficient", 0, None, None, n, "requires at least 30 daily observations")
    s = _mann_kendall_s(x)
    var_s = _mann_kendall_variance(x)
    if var_s <= 0:
        return MannKendallResult("no_trend", s, 0.0, 1.0, n)
    z = _z_score(s, var_s)
    p_value = math.erfc(abs(z) / math.sqrt(2.0))
    return MannKendallResult(_trend_from_z(z, p_value), s, float(z), float(p_value), n)


def fold_sequence_slope(oos_sharpes: List[Optional[float]]) -> Optional[FoldSlope]:
    values = [float(v) for v in oos_sharpes if v is not None and np.isfinite(float(v))]
    if len(values) < 3:
        return None
    y = np.asarray(values, dtype=np.float64)
    x = np.arange(y.size, dtype=np.float64)
    slope, intercept = np.polyfit(x, y, 1)
    fitted = intercept + slope * x
    denom = float(np.sum((y - y.mean()) ** 2))
    r2 = 0.0 if denom <= 1e-12 else float(1.0 - np.sum((y - fitted) ** 2) / denom)
    return FoldSlope(float(slope), r2, int(y.size))


def months_to_cost_breakeven(trades: List[ClosedTrade], exposure: Any, ts_ns: np.ndarray) -> BreakevenProjection:
    del ts_ns
    closed = list(trades)
    n = len(closed)
    total_cost = float(getattr(exposure, "total_fees", 0.0) + getattr(exposure, "total_funding", 0.0) + getattr(exposure, "total_borrow", 0.0))
    if n < 20:
        return BreakevenProjection("insufficient_history", None, None, None, None, 0, n, "requires at least 20 closed trades")
    per_trade_cost = total_cost / n if n else None
    by_month: dict[pd.Period, list[float]] = defaultdict(list)
    for trade in closed:
        ts = pd.Timestamp(int(trade.exit_ts_ns), unit="ns", tz="UTC").to_period("M")
        by_month[ts].append(float(trade.pnl + trade.fees + trade.funding + trade.borrow))
    months = sorted(by_month)
    if len(months) < 4:
        return BreakevenProjection("insufficient_history", None, None, None, per_trade_cost, len(months), n, "requires at least 4 exit months")
    y = np.asarray([float(np.mean(by_month[m])) for m in months], dtype=np.float64)
    x = np.arange(y.size, dtype=np.float64)
    slope, _ = np.polyfit(x, y, 1)
    latest = float(y[-1])
    if slope < 0 and per_trade_cost is not None:
        projected = max(0.0, (latest - per_trade_cost) / abs(float(slope)))
        return BreakevenProjection("projected", float(projected), float(slope), latest, per_trade_cost, len(months), n)
    return BreakevenProjection("no_measured_decay", None, float(slope), latest, per_trade_cost, len(months), n)


def _daily_last_rolling_sharpe(rolling_sharpe: np.ndarray, ts_ns: np.ndarray, window: int) -> np.ndarray:
    if rolling_sharpe.size == 0 or ts_ns.size <= window:
        return np.zeros(0, dtype=np.float64)
    idx = ts_ns[window:window + rolling_sharpe.size]
    s = pd.Series(rolling_sharpe, index=pd.to_datetime(idx, unit="ns", utc=True))
    return s.resample("1D").last().dropna().to_numpy(dtype=np.float64)


def _decay_reasons(mk: MannKendallResult, fold_slope: Optional[FoldSlope], breakeven: BreakevenProjection) -> list[str]:
    reasons: list[str] = []
    if mk.trend == "insufficient":
        reasons.append(mk.reason or "insufficient rolling Sharpe history")
    if fold_slope is None:
        reasons.append("requires at least 3 walk-forward folds")
    if breakeven.status == "insufficient_history":
        reasons.append(breakeven.reason or "insufficient trade history")
    return reasons


def _mk_decreasing(mk: MannKendallResult, threshold: float) -> bool:
    if mk.trend != "decreasing" or mk.p_value is None:
        return False
    return mk.p_value < threshold


def _fold_below(fold_slope: Optional[FoldSlope], threshold: float) -> bool:
    return fold_slope is not None and fold_slope.slope < threshold


def _months_at_or_below(breakeven: BreakevenProjection, threshold: float) -> bool:
    return breakeven.months is not None and breakeven.months <= threshold


def _all_decay_inputs_insufficient(
    mk: MannKendallResult,
    fold_slope: Optional[FoldSlope],
    breakeven: BreakevenProjection,
) -> bool:
    return all(
        [
            mk.trend == "insufficient",
            fold_slope is None,
            breakeven.status == "insufficient_history",
        ]
    )


@dataclass(frozen=True)
class DecayThresholds:
    mk_p_value: float
    fold_slope: float
    breakeven_months: float


def _has_decay(
    mk: MannKendallResult,
    fold_slope: Optional[FoldSlope],
    breakeven: BreakevenProjection,
    thresholds: DecayThresholds,
) -> bool:
    return any(
        [
            _mk_decreasing(mk, thresholds.mk_p_value),
            _fold_below(fold_slope, thresholds.fold_slope),
            _months_at_or_below(breakeven, thresholds.breakeven_months),
        ]
    )


MATERIAL_DECAY = DecayThresholds(0.01, -0.3, 12)
MILD_DECAY = DecayThresholds(0.05, -0.15, 36)


def _decay_label(
    mk: MannKendallResult,
    fold_slope: Optional[FoldSlope],
    breakeven: BreakevenProjection,
) -> str:
    if _all_decay_inputs_insufficient(mk, fold_slope, breakeven):
        return "insufficient"
    if _has_decay(mk, fold_slope, breakeven, MATERIAL_DECAY):
        return "decaying"
    if _has_decay(mk, fold_slope, breakeven, MILD_DECAY):
        return "mild_decay"
    return "stable"


def _high_confidence(daily_size: int, fold_count: int, trade_count: int) -> bool:
    return all([daily_size >= 120, fold_count >= 5, trade_count >= 50])


def _medium_confidence(daily_size: int, fold_count: int, trade_count: int) -> bool:
    return any([daily_size >= 60, fold_count >= 3, trade_count >= 20])


def _confidence(daily_size: int, fold_count: int, trade_count: int, label: str) -> str:
    if _high_confidence(daily_size, fold_count, trade_count):
        return "high"
    if _medium_confidence(daily_size, fold_count, trade_count):
        return "medium"
    return "insufficient" if label == "insufficient" else "low"


def compute_alpha_decay(input: AlphaDecayInput) -> Optional[Dict[str, Any]]:
    daily = _daily_last_rolling_sharpe(input.rolling_sharpe, input.ts_ns, input.window)
    mk = mann_kendall(daily)
    folds = getattr(input.walk_forward, "folds", None) or []
    fold_slope = fold_sequence_slope([getattr(f, "oos_sharpe", None) for f in folds])
    breakeven = months_to_cost_breakeven(input.trades, input.exposure, input.ts_ns)
    label = _decay_label(mk, fold_slope, breakeven)
    fold_count = int(getattr(input.walk_forward, "n_folds", 0) or 0)

    return {
        "mann_kendall": mk.__dict__,
        "fold_slope": fold_slope.__dict__ if fold_slope is not None else None,
        "breakeven": breakeven.__dict__,
        "label": label,
        "confidence": _confidence(int(daily.size), fold_count, len(input.trades), label),
        "reasons": _decay_reasons(mk, fold_slope, breakeven),
    }
