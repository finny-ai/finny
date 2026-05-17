"""Top-level event loop. Iterates bars, drives broker.process_bar, calls
strategy.on_bar (or v1 step()), captures equity series + diagnostics."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List

import numpy as np

from ..core.arrays import MarketSnapshot
from .broker import PortfolioBroker


@dataclass
class LoopResult:
    equity_curve: np.ndarray   # length = n_bars
    gross_exposure: np.ndarray # length = n_bars — $ notional of all open positions
    diagnostics: List[Dict[str, Any]]


def run_loop(
    broker: PortfolioBroker,
    market: MarketSnapshot,
    on_bar: Callable[[], Dict[str, Any]],
) -> LoopResult:
    n = market.n
    equity = np.zeros(n, dtype=np.float64)
    exposure = np.zeros(n, dtype=np.float64)
    diags: List[Dict[str, Any]] = []
    for i in range(n):
        market.set_index(i)
        broker.process_bar(i)
        diag = on_bar() or {}
        eq = broker.get_equity()
        diag["equity"] = eq
        diag["bar"] = i
        equity[i] = eq
        # Snapshot gross notional at end of bar (after fills + marks). Used
        # by metrics.exposure for accurate time-in-market and exposure stats.
        exposure[i] = broker.book.gross_exposure(broker.account.last_prices)
        diags.append(diag)
    return LoopResult(equity_curve=equity, gross_exposure=exposure, diagnostics=diags)
