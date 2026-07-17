"""Realized-volatility regime breakdown.

Each bar is classified with only prior data. The rolling realized volatility
for bar i uses closes before i, and low/mid/high thresholds are expanding
historical terciles from prior realized-vol observations.
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
    for i in range(lookback + 1, n):
        end = i - 1
        start = end - lookback
        window_sum = cs[end - 1] - (cs[start - 1] if start > 0 else 0.0)
        realized[i] = np.sqrt(window_sum / lookback)
    for i in range(n):
        v = realized[i]
        if np.isnan(v):
            continue
        prior = realized[:i]
        prior = prior[~np.isnan(prior)]
        if prior.size < 30:
            continue
        t1 = float(np.quantile(prior, 1.0 / 3.0))
        t2 = float(np.quantile(prior, 2.0 / 3.0))
        if v <= t1:
            out[i] = 0
        elif v <= t2:
            out[i] = 1
        else:
            out[i] = 2
    return out


# ── Volatility regime labels (human-readable) ──
VOL_LABELS = {-1: "warmup", 0: "low_vol", 1: "mid_vol", 2: "high_vol"}


def classify_trend(close: np.ndarray, lookback: int = 50) -> np.ndarray:
    """Trend regime based on SMA slope direction and price position.

    Returns int8 array same length as close:
      1  = uptrend   (close > SMA AND SMA slope > 0)
      0  = sideways  (mixed signals or warmup-adjacent)
     -1  = downtrend (close < SMA AND SMA slope < 0)
     -2  = warmup    (not enough bars)

    Uses only settled data — SMA at bar i is computed from closes[0..i-1]
    (excludes current bar) so it's safe at decision time.
    """
    n = close.size
    out = np.full(n, -2, dtype=np.int8)
    if n < lookback + 2:
        return out

    # Rolling SMA of settled closes (shifted by 1 so SMA[i] uses bars before i)
    sma = np.full(n, np.nan)
    cs = np.cumsum(close)
    for i in range(lookback, n):
        # SMA of closes from [i-lookback .. i-1] — all settled before bar i
        sma[i] = (cs[i - 1] - (cs[i - lookback - 1] if i > lookback else 0.0)) / lookback

    # Slope: SMA change over last 5 bars (smoothed so noise doesn't flip regime)
    slope_window = 5
    for i in range(lookback + slope_window, n):
        if np.isnan(sma[i]) or np.isnan(sma[i - slope_window]):
            continue
        slope = sma[i] - sma[i - slope_window]
        prev_close = close[i - 1]  # Settled close, not current bar
        above_sma = prev_close > sma[i]
        below_sma = prev_close < sma[i]

        if slope > 0 and above_sma:
            out[i] = 1   # uptrend
        elif slope < 0 and below_sma:
            out[i] = -1  # downtrend
        else:
            out[i] = 0   # sideways / conflicting signals

    return out


# ── Trend regime labels (human-readable) ──
TREND_LABELS = {-2: "warmup", -1: "downtrend", 0: "sideways", 1: "uptrend"}


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
    all_ret = np.full(max(equity.size - 1, 0), np.nan)
    prev = equity[:-1]
    valid = prev > 0
    all_ret[valid] = (equity[1:][valid] - prev[valid]) / prev[valid]
    for label_id, name in names.items():
        mask = bar_labels == label_id
        n = int(mask.sum())
        pct = float(n / total_n) if total_n else 0.0
        if n < 5:
            out.append(Regime(name, n, pct, 0.0, 0.0, 0.0, 0, 0.0))
            continue
        # Use returns from bars actually in this regime — no cross-regime leak.
        seg_ret = all_ret[mask[1:]]
        seg_ret = seg_ret[np.isfinite(seg_ret)]
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
