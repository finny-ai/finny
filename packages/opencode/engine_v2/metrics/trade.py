"""Trade-level metrics over a list of ClosedTrade records."""

from __future__ import annotations

from typing import Dict, List, Optional

import numpy as np

from ..portfolio.positions import ClosedTrade


def _r_multiple(t: ClosedTrade) -> Optional[float]:
    if t.stop_distance is None or t.stop_distance <= 0 or t.qty <= 0:
        return None
    return float(t.pnl / (t.stop_distance * t.qty))


def kelly_confidence(n_trades: int) -> str:
    if n_trades < 50:
        return "low"
    if n_trades < 200:
        return "medium"
    return "high"


def compute(trades: List[ClosedTrade]) -> Dict:
    n = len(trades)
    if n == 0:
        return {
            "total_trades": 0, "win_rate": 0.0, "loss_rate": 0.0, "breakeven_rate": 0.0,
            "avg_win": 0.0, "avg_loss": 0.0, "payoff_ratio": 0.0, "expectancy": 0.0,
            "expectancy_r": None, "profit_factor": 0.0,
            "max_consecutive_wins": 0, "max_consecutive_losses": 0,
            "longest_trade_bars": 0, "shortest_trade_bars": 0, "avg_hold_bars": 0.0,
            "mae_avg": 0.0, "mae_max": 0.0, "mfe_avg": 0.0, "mfe_max": 0.0,
            "kelly_fraction": 0.0, "kelly_confidence": "low",
            "trade_tstat": None, "trade_pvalue": None,
        }
    pnls = np.array([t.pnl for t in trades], dtype=np.float64)
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]
    bes = pnls[pnls == 0]
    win_rate = float(wins.size / n)
    loss_rate = float(losses.size / n)
    be_rate = float(bes.size / n)
    avg_win = float(wins.mean()) if wins.size else 0.0
    avg_loss = float(losses.mean()) if losses.size else 0.0
    payoff = float(abs(avg_win) / abs(avg_loss)) if avg_loss < 0 else 0.0
    expectancy = float(pnls.mean())
    gp = float(wins.sum())
    gl = float(abs(losses.sum()))
    pf = float(gp / gl) if gl > 0 else (0.0 if gp == 0 else None)

    r_vals = [r for r in (_r_multiple(t) for t in trades) if r is not None]
    expectancy_r = float(np.mean(r_vals)) if r_vals else None

    # Consecutive runs
    streak_w, streak_l, max_w, max_l = 0, 0, 0, 0
    for p in pnls:
        if p > 0:
            streak_w += 1
            streak_l = 0
            max_w = max(max_w, streak_w)
        elif p < 0:
            streak_l += 1
            streak_w = 0
            max_l = max(max_l, streak_l)
        else:
            streak_w = 0
            streak_l = 0

    holds = np.array([t.hold_bars for t in trades], dtype=np.int64)
    maes = np.array([t.mae for t in trades], dtype=np.float64)
    mfes = np.array([t.mfe for t in trades], dtype=np.float64)

    # Kelly: f* = win_rate - (1-win_rate)/payoff  (for win/loss bets with fixed payoff)
    kelly = 0.0
    if payoff > 0 and win_rate > 0:
        kelly = float(win_rate - (1.0 - win_rate) / payoff)

    # Trade significance: t-test on PnLs — "are these returns distinguishable
    # from random?" regardless of trade count.
    trade_tstat = None
    trade_pvalue = None
    if n >= 2:
        _mean = float(pnls.mean())
        _std = float(pnls.std(ddof=1))
        if _std > 0:
            trade_tstat = _mean / (_std / float(np.sqrt(n)))
            # Abramowitz & Stegun 26.2.17 — normal CDF approximation (max err 7.5e-8)
            _z = abs(trade_tstat)
            _p = 0.2316419
            _b1, _b2, _b3, _b4, _b5 = 0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429
            _t = 1.0 / (1.0 + _p * _z)
            _phi = (1.0 / np.sqrt(2.0 * np.pi)) * np.exp(-0.5 * _z * _z)
            _norm_cdf = 1.0 - _phi * (_b1*_t + _b2*_t**2 + _b3*_t**3 + _b4*_t**4 + _b5*_t**5)
            trade_pvalue = float(2.0 * (1.0 - _norm_cdf))

    return {
        "total_trades": int(n),
        "win_rate": win_rate, "loss_rate": loss_rate, "breakeven_rate": be_rate,
        "avg_win": avg_win, "avg_loss": avg_loss, "payoff_ratio": payoff,
        "expectancy": expectancy, "expectancy_r": expectancy_r, "profit_factor": pf,
        "max_consecutive_wins": int(max_w), "max_consecutive_losses": int(max_l),
        "longest_trade_bars": int(holds.max()),
        "shortest_trade_bars": int(holds.min()),
        "avg_hold_bars": float(holds.mean()),
        "mae_avg": float(maes.mean()) if maes.size else 0.0,
        "mae_max": float(maes.max()) if maes.size else 0.0,
        "mfe_avg": float(mfes.mean()) if mfes.size else 0.0,
        "mfe_max": float(mfes.max()) if mfes.size else 0.0,
        "kelly_fraction": kelly,
        "kelly_confidence": kelly_confidence(n),
        "trade_tstat": trade_tstat,
        "trade_pvalue": trade_pvalue,
    }
