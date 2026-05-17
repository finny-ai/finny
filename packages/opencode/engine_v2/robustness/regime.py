"""Realized-volatility tercile regime breakdown.

Each bar is classified into low/mid/high vol based on the tercile thresholds
of rolling 30-bar realized vol *over the test window itself*. No bull/bear
hand-waving — purely about volatility regime, where most strategies
genuinely behave differently. Per-regime metrics surface where a strategy
breaks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

import numpy as np

from ..metrics import drawdown as DD
from ..metrics import ratios as RAT
from ..portfolio.positions import ClosedTrade


@dataclass
class Regime:
    regime: str
    n_bars: int
    pct_of_window: float
    total_return: float
    sharpe: float
    max_drawdown: float
    n_trades: int
    win_rate: float


def classify_bars(close: np.ndarray, lookback: int = 30) -> np.ndarray:
    """Returns int8 array same length as close: 0=low, 1=mid, 2=high, -1=warmup."""
    n = close.size
    out = np.full(n, -1, dtype=np.int8)
    if n < lookback + 5:
        return out
    log_ret = np.diff(np.log(np.clip(close, 1e-12, None)))
    realized = np.full(n, np.nan)
    cs = np.cumsum(log_ret ** 2)
    for i in range(lookback, n):
        window_sum = cs[i - 1] - (cs[i - lookback - 1] if i > lookback else 0.0)
        realized[i] = np.sqrt(window_sum / lookback)
    valid = realized[~np.isnan(realized)]
    if valid.size < 30:
        return out
    t1 = float(np.quantile(valid, 1.0 / 3.0))
    t2 = float(np.quantile(valid, 2.0 / 3.0))
    for i in range(n):
        v = realized[i]
        if np.isnan(v):
            continue
        if v <= t1:
            out[i] = 0
        elif v <= t2:
            out[i] = 1
        else:
            out[i] = 2
    return out


def breakdown(
    equity: np.ndarray, bar_labels: np.ndarray,
    ts_ns: np.ndarray, trades: List[ClosedTrade], bars_per_year: float,
) -> List[Regime]:
    if equity.size < 30:
        return []
    out: List[Regime] = []
    names = {0: "low_vol", 1: "mid_vol", 2: "high_vol"}
    total_n = int((bar_labels >= 0).sum())
    # Per-bar returns, aligned to bars 1..n-1 (bar 0 has no prior return).
    all_ret = (equity[1:] - equity[:-1]) / np.clip(equity[:-1], 1e-12, None)
    for label_id, name in names.items():
        mask = bar_labels == label_id
        n = int(mask.sum())
        pct = float(n / total_n) if total_n else 0.0
        if n < 5:
            out.append(Regime(name, n, pct, 0.0, 0.0, 0.0, 0, 0.0))
            continue
        # Use returns from bars actually in this regime — no cross-regime leak.
        seg_ret = all_ret[mask[1:]]
        total = float(np.prod(1.0 + seg_ret) - 1.0) if seg_ret.size else 0.0
        sharpe = RAT.sharpe(seg_ret, bars_per_year=bars_per_year)
        seg_eq = np.cumprod(1.0 + seg_ret) if seg_ret.size else np.ones(1)
        mdd = DD.max_drawdown(seg_eq)
        regime_trades = [t for t in trades
                         if 0 <= np.searchsorted(ts_ns, t.entry_ts_ns) < bar_labels.size
                         and bar_labels[min(np.searchsorted(ts_ns, t.entry_ts_ns), bar_labels.size - 1)] == label_id]
        nt = len(regime_trades)
        wr = float(sum(1 for t in regime_trades if t.pnl > 0) / nt) if nt else 0.0
        out.append(Regime(
            regime=name, n_bars=n, pct_of_window=pct,
            total_return=total, sharpe=sharpe, max_drawdown=mdd,
            n_trades=nt, win_rate=wr,
        ))
    return out
