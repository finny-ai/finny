"""Exposure / turnover / fees / funding totals."""

from __future__ import annotations

from typing import Dict, List

import numpy as np

from ..execution.fills import Fill
from ..portfolio.positions import ClosedTrade


def compute(
    equity_curve: np.ndarray,
    position_history: np.ndarray,   # shape (n_bars,) — gross_exposure each bar
    fills_log: List[Fill],
    trades: List[ClosedTrade],
    starting_equity: float,
    total_years: float,
) -> Dict:
    n = equity_curve.size
    in_market = float((position_history > 0).mean()) if n else 0.0
    avg_gross = float(position_history.mean()) if n else 0.0
    max_gross = float(position_history.max()) if n else 0.0
    # Net exposure tracked separately would need signed history; using gross
    # as a conservative stand-in until signed history is added to the loop.
    avg_net = avg_gross

    total_notional = float(sum(f.qty * f.price for f in fills_log))
    turnover = float(total_notional / starting_equity) if starting_equity > 0 else 0.0
    turnover_per_year = float(turnover / total_years) if total_years > 0 else turnover

    total_fees = float(sum(t.fees for t in trades) + sum(f.fee for f in fills_log if f.tag == "LIQUIDATION"))
    total_funding = float(sum(t.funding for t in trades))
    total_borrow = float(sum(t.borrow for t in trades))

    final_pnl = float(equity_curve[-1] - starting_equity) if n else 0.0
    fees_as_pct = float(total_fees / abs(final_pnl)) if abs(final_pnl) > 1e-9 else None

    liq_count = int(sum(1 for t in trades if t.liquidation))

    return {
        "time_in_market_pct": in_market,
        "avg_gross_exposure": avg_gross,
        "avg_net_exposure": avg_net,
        "max_gross_exposure": max_gross,
        "total_turnover": turnover,
        "turnover_per_year": turnover_per_year,
        "total_fees": total_fees,
        "fees_as_pct_return": fees_as_pct,
        "total_funding": total_funding,
        "total_borrow": total_borrow,
        "liquidation_count": liq_count,
    }
