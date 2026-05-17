"""Monte-Carlo robustness:

  - trade_shuffle: permute the realized trade PnL sequence N times to derive
    a distribution of final equity, max drawdown, and Sharpe. Answers
    "is today's drawdown structural, or did we get lucky on order?"

  - block_bootstrap: stationary block bootstrap of bar returns (Politis-
    Romano) to preserve serial correlation. Block length defaults to
    sqrt(n_bars) — heuristic but standard.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List

import numpy as np

from ..core.rng import make_rng
from ..metrics import drawdown as DD
from ..metrics import ratios as RAT


@dataclass
class MCResult:
    n_paths: int
    method: str
    final_equity_p5: float
    final_equity_p50: float
    final_equity_p95: float
    max_dd_p50: float
    max_dd_p95: float
    max_dd_p99: float
    sharpe_p5: float
    sharpe_p50: float
    sharpe_p95: float


def _equity_from_pnls(pnls: np.ndarray, starting: float) -> np.ndarray:
    return starting + np.cumsum(pnls)


def trade_shuffle(
    trade_pnls: np.ndarray, starting_equity: float, bars_per_year: float,
    n_paths: int = 1000, seed: int = 0,
) -> MCResult:
    if n_paths <= 0:
        return MCResult(0, "trade_shuffle", starting_equity, starting_equity, starting_equity,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    rng = make_rng(seed)
    if trade_pnls.size == 0:
        return MCResult(0, "trade_shuffle", starting_equity, starting_equity, starting_equity,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    finals = np.zeros(n_paths)
    dds = np.zeros(n_paths)
    sharpes = np.zeros(n_paths)
    for p in range(n_paths):
        perm = rng.permutation(trade_pnls.size)
        eq = _equity_from_pnls(trade_pnls[perm], starting_equity)
        finals[p] = eq[-1]
        dds[p] = DD.max_drawdown(eq)
        rets = np.diff(eq) / np.clip(eq[:-1], 1e-12, None)
        sharpes[p] = RAT.sharpe(rets, bars_per_year=bars_per_year)
    return MCResult(
        n_paths=n_paths, method="trade_shuffle",
        final_equity_p5=float(np.quantile(finals, 0.05)),
        final_equity_p50=float(np.quantile(finals, 0.50)),
        final_equity_p95=float(np.quantile(finals, 0.95)),
        max_dd_p50=float(np.quantile(dds, 0.50)),
        max_dd_p95=float(np.quantile(dds, 0.05)),     # 5th pct of DDs = 95th-worst
        max_dd_p99=float(np.quantile(dds, 0.01)),
        sharpe_p5=float(np.quantile(sharpes, 0.05)),
        sharpe_p50=float(np.quantile(sharpes, 0.50)),
        sharpe_p95=float(np.quantile(sharpes, 0.95)),
    )


def block_bootstrap(
    bar_returns: np.ndarray, starting_equity: float, bars_per_year: float,
    n_paths: int = 1000, block_len: int = 0, seed: int = 0,
) -> MCResult:
    if n_paths <= 0:
        return MCResult(0, "block_bootstrap", starting_equity, starting_equity, starting_equity,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    rng = make_rng(seed)
    n = bar_returns.size
    if n < 30:
        return MCResult(0, "block_bootstrap", starting_equity, starting_equity, starting_equity,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    if block_len <= 0:
        block_len = max(2, int(round(math.sqrt(n))))
    finals = np.zeros(n_paths)
    dds = np.zeros(n_paths)
    sharpes = np.zeros(n_paths)
    for p in range(n_paths):
        # Stationary bootstrap: geometric block length around `block_len`
        out = np.empty(n)
        i = 0
        while i < n:
            start = int(rng.integers(0, n))
            blen = int(rng.geometric(1.0 / block_len))
            blen = max(1, min(blen, n - i))
            for j in range(blen):
                out[i + j] = bar_returns[(start + j) % n]
            i += blen
        eq = starting_equity * np.cumprod(1.0 + out)
        finals[p] = eq[-1]
        dds[p] = DD.max_drawdown(eq)
        sharpes[p] = RAT.sharpe(out, bars_per_year=bars_per_year)
    return MCResult(
        n_paths=n_paths, method="block_bootstrap",
        final_equity_p5=float(np.quantile(finals, 0.05)),
        final_equity_p50=float(np.quantile(finals, 0.50)),
        final_equity_p95=float(np.quantile(finals, 0.95)),
        max_dd_p50=float(np.quantile(dds, 0.50)),
        max_dd_p95=float(np.quantile(dds, 0.05)),
        max_dd_p99=float(np.quantile(dds, 0.01)),
        sharpe_p5=float(np.quantile(sharpes, 0.05)),
        sharpe_p50=float(np.quantile(sharpes, 0.50)),
        sharpe_p95=float(np.quantile(sharpes, 0.95)),
    )
