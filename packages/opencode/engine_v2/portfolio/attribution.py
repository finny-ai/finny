"""Per-symbol P&L attribution from closed trades + open marks."""

from __future__ import annotations

from typing import Dict, List

from .positions import ClosedTrade, Position


def per_symbol(trades: List[ClosedTrade], positions: Dict[str, Position],
               last_prices: Dict[str, float], total_pnl: float) -> List[dict]:
    by: Dict[str, dict] = {}
    for t in trades:
        d = by.setdefault(t.symbol, {"realized": 0.0, "n_trades": 0, "wins": 0})
        d["realized"] += t.pnl
        d["n_trades"] += 1
        if t.pnl > 0:
            d["wins"] += 1
    for sym, pos in positions.items():
        if pos.qty == 0:
            continue
        d = by.setdefault(sym, {"realized": 0.0, "n_trades": 0, "wins": 0})
        px = last_prices.get(sym, pos.avg_price)
        d.setdefault("unrealized", 0.0)
        d["unrealized"] = pos.qty * (px - pos.avg_price) * pos.multiplier

    out = []
    for sym, d in sorted(by.items()):
        n = d.get("n_trades", 0)
        wr = (d.get("wins", 0) / n) if n else 0.0
        unrealized = d.get("unrealized", 0.0)
        sym_pnl = d["realized"] + unrealized
        contribution = (sym_pnl / total_pnl) if abs(total_pnl) > 1e-12 else 0.0
        out.append({
            "symbol": sym,
            "realized_pnl": d["realized"],
            "unrealized_pnl": unrealized,
            "n_trades": n,
            "win_rate": wr,
            "contribution_pct": contribution,
        })
    return out
