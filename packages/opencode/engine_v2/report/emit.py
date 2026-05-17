"""Assemble a Results object from engine outputs + emit results.json /
equity.csv / trades.csv / diagnostics.csv."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from ..core.arrays import MarketSnapshot
from ..execution.fills import Fill
from ..metrics import benchmark as M_benchmark
from ..metrics import drawdown as M_dd
from ..metrics import exposure as M_exposure
from ..metrics import ratios as M_ratios
from ..metrics import returns as M_returns
from ..metrics import risk as M_risk
from ..metrics import stability as M_stability
from ..metrics import trade as M_trade
from ..portfolio.attribution import per_symbol
from ..portfolio.positions import ClosedTrade
from ..runtime.broker import PortfolioBroker
from . import schema as S


def _gross_exposure_history(broker: PortfolioBroker, snap: MarketSnapshot, equity: np.ndarray) -> np.ndarray:
    # We don't snapshot per-bar exposure in the loop today; approximate
    # using ratio of (equity - cash) magnitude. For the v2 ship this is good
    # enough; per-bar history can be added later if needed.
    n = equity.size
    if n == 0:
        return np.zeros(0)
    # Best available proxy: 1 when in any position at end of run, scaled.
    return np.where(equity > 0, 1.0, 0.0) * 0.0  # zero placeholder; replaced below
    # NOTE: filled in by callers that track exposure during run.


def assemble(
    broker: PortfolioBroker,
    snap: MarketSnapshot,
    equity: np.ndarray,
    diagnostics: List[Dict[str, Any]],
    exposure_history: np.ndarray,
    starting_equity: float,
    interval: str,
    bars_per_year: float,
    seed: int,
    schema_engine_version: str,
    benchmark_returns: Optional[np.ndarray] = None,
    benchmark_symbol: Optional[str] = None,
    monte_carlo: Optional[Any] = None,
    walk_forward: Optional[Any] = None,
    regimes: Optional[List[Any]] = None,
    data_quality: Optional[Any] = None,
) -> S.Results:
    trades = broker.book.trades
    ts_ns = snap.ts
    returns = M_returns.bar_returns(equity)

    # Returns metrics
    dmin, dmax = M_returns.daily_extremes(equity, ts_ns)
    mmin, mmax = M_returns.monthly_extremes(equity, ts_ns)
    ret_block = S.ReturnMetrics(
        total_return=M_returns.total_return(equity),
        cagr=M_returns.cagr(equity, ts_ns),
        time_weighted_return=M_returns.time_weighted_return(equity),
        money_weighted_return=None,
        best_day=dmax, worst_day=dmin,
        best_month=mmax, worst_month=mmin,
        pct_positive_months=M_returns.pct_positive_periods(equity, ts_ns, "1ME") or 0.0,
        pct_positive_years=M_returns.pct_positive_periods(equity, ts_ns, "1YE"),
    )

    # Risk
    risk_block = S.RiskMetrics(
        ann_vol=M_risk.ann_vol(returns, bars_per_year),
        downside_deviation=M_risk.downside_deviation(returns),
        semi_variance=M_risk.semi_variance(returns),
        skew=M_risk.skewness(returns),
        kurtosis=M_risk.kurtosis(returns),
        var_95=M_risk.value_at_risk(returns, 0.95),
        var_99=M_risk.value_at_risk(returns, 0.99),
        cvar_95=M_risk.conditional_var(returns, 0.95),
        cvar_99=M_risk.conditional_var(returns, 0.99),
        ulcer_index=M_risk.ulcer_index(equity),
        pain_index=M_risk.pain_index(equity),
        tail_ratio=M_risk.tail_ratio(returns),
    )

    # Ratios
    ratios_block = S.RatioMetrics(
        sharpe=M_ratios.sharpe(returns, bars_per_year),
        sortino=M_ratios.sortino(returns, bars_per_year),
        calmar=M_ratios.calmar(equity, ts_ns),
        omega=M_ratios.omega(returns),
        mar=M_ratios.mar(equity, ts_ns),
        sterling=M_ratios.sterling(equity, ts_ns),
        k_ratio=M_ratios.k_ratio(equity),
    )

    # Drawdown
    mdd = M_dd.max_drawdown(equity)
    dur, recov = M_dd.max_dd_periods(equity)
    dd_block = S.DrawdownMetrics(
        max_drawdown=mdd,
        max_dd_duration_bars=dur,
        max_dd_recovery_bars=recov,
        avg_drawdown=M_dd.avg_drawdown(equity),
        avg_dd_duration_bars=M_dd.avg_dd_duration(equity),
        current_drawdown=M_dd.current_drawdown(equity),
        top_drawdowns=[
            S.DrawdownEntry(
                start_ts=str(pd.Timestamp(int(ts_ns[p.start_idx]), unit="ns", tz="UTC")),
                trough_ts=str(pd.Timestamp(int(ts_ns[p.trough_idx]), unit="ns", tz="UTC")),
                end_ts=str(pd.Timestamp(int(ts_ns[p.end_idx]), unit="ns", tz="UTC")) if p.end_idx is not None else None,
                depth=p.depth, duration_bars=p.duration_bars, recovery_bars=p.recovery_bars,
            )
            for p in M_dd.top_drawdowns(equity, k=5)
        ],
    )

    # Trade
    t_metrics = M_trade.compute(trades)
    trade_block = S.TradeMetrics(**t_metrics)

    # Exposure
    if ts_ns.size >= 2:
        total_years = max(1e-6, (ts_ns[-1] - ts_ns[0]) / (86_400_000_000_000.0 * 365.0))
    else:
        total_years = 1e-6
    ex = M_exposure.compute(equity, exposure_history, broker.fills_log, trades,
                            starting_equity, total_years)
    ex_block = S.ExposureMetrics(**ex)

    # Stability
    rsh_mean, rsh_min, _ = M_stability.rolling_sharpe(returns, bars_per_year, window=90)
    stab_block = S.StabilityMetrics(
        equity_curve_r2=M_stability.equity_r2(equity),
        rolling_sharpe_window=90,
        rolling_sharpe_mean=rsh_mean,
        rolling_sharpe_min=rsh_min,
        monthly_returns=M_stability.monthly_returns_heatmap(equity, ts_ns),
    )

    # Benchmark
    bench_block: Optional[S.BenchmarkMetrics] = None
    if benchmark_returns is not None and benchmark_symbol is not None:
        bm = M_benchmark.compute(returns, benchmark_returns, bars_per_year)
        if bm is not None:
            bench_block = S.BenchmarkMetrics(benchmark_symbol=benchmark_symbol, **bm)

    # Trades schema
    trades_rows: List[S.TradeRow] = []
    for t in trades:
        notional = t.entry_price * t.qty if t.qty > 0 else 0.0
        pnl_pct = float(t.pnl / notional) if notional > 0 else 0.0
        r_mult = None
        if t.stop_distance is not None and t.stop_distance > 0 and t.qty > 0:
            r_mult = float(t.pnl / (t.stop_distance * t.qty))
        trades_rows.append(S.TradeRow(
            symbol=t.symbol, side=t.side,
            entry_ts=str(pd.Timestamp(int(t.entry_ts_ns), unit="ns", tz="UTC")),
            exit_ts=str(pd.Timestamp(int(t.exit_ts_ns), unit="ns", tz="UTC")),
            qty=t.qty, entry_price=t.entry_price, exit_price=t.exit_price,
            pnl=t.pnl, pnl_pct=pnl_pct, r_multiple=r_mult,
            fees=t.fees, funding=t.funding, borrow=t.borrow,
            mae=t.mae, mfe=t.mfe, hold_bars=t.hold_bars,
            entry_tag=t.entry_tag, exit_tag=t.exit_tag, liquidation=t.liquidation,
        ))

    # Per-symbol attribution
    last_prices = {s: float(snap.arrays[s].close[-1]) for s in snap.symbols}
    total_pnl = float(equity[-1] - starting_equity) if equity.size else 0.0
    attribs = per_symbol(trades, broker.book.positions, last_prices, total_pnl)
    attrib_rows = [S.PerSymbolAttribution(**a) for a in attribs]

    # Data quality
    if data_quality is None:
        data_quality = S.DataQualityReport(
            n_bars=int(snap.n), coverage_pct=1.0, gap_count=0,
            duplicate_ts_count=0, ohlc_violations=0, outlier_bars=0,
            zero_volume_bars=0, notes=[],
        )
    else:
        data_quality = S.DataQualityReport(
            n_bars=data_quality.n_bars, coverage_pct=data_quality.coverage_pct,
            gap_count=data_quality.gap_count, duplicate_ts_count=data_quality.duplicate_ts_count,
            ohlc_violations=data_quality.ohlc_violations, outlier_bars=data_quality.outlier_bars,
            zero_volume_bars=data_quality.zero_volume_bars, notes=data_quality.notes,
        )

    # Monte-Carlo
    mc_block = None
    if monte_carlo is not None:
        mc_block = S.MonteCarloSummary(**asdict(monte_carlo))

    # Walk-forward
    wf_block = None
    if walk_forward is not None:
        wf_block = S.WalkForwardSummary(
            n_folds=walk_forward.n_folds,
            is_sharpe_mean=walk_forward.is_sharpe_mean,
            oos_sharpe_mean=walk_forward.oos_sharpe_mean,
            oos_decay=walk_forward.oos_decay,
            flag_threshold=walk_forward.flag_threshold,
            flagged=walk_forward.flagged,
            deflated_sharpe=walk_forward.deflated_sharpe,
            probabilistic_sharpe=walk_forward.probabilistic_sharpe,
            folds=[
                S.WalkForwardFold(
                    fold=f.fold,
                    train_start=str(pd.Timestamp(f.train_start_ns, unit="ns", tz="UTC")),
                    train_end=str(pd.Timestamp(f.train_end_ns, unit="ns", tz="UTC")),
                    test_start=str(pd.Timestamp(f.test_start_ns, unit="ns", tz="UTC")),
                    test_end=str(pd.Timestamp(f.test_end_ns, unit="ns", tz="UTC")),
                    is_sharpe=f.is_sharpe, oos_sharpe=f.oos_sharpe,
                    is_return=f.is_return, oos_return=f.oos_return,
                )
                for f in walk_forward.folds
            ],
        )

    regimes_block = None
    if regimes is not None:
        regimes_block = [S.RegimeBreakdown(**asdict(r)) for r in regimes]

    return S.Results(
        schema_version=S.SCHEMA_VERSION,
        engine_version=schema_engine_version,
        seed=seed,
        starting_equity=float(starting_equity),
        ending_equity=float(equity[-1]) if equity.size else float(starting_equity),
        bars_processed=int(equity.size),
        interval=interval,
        start_ts=str(pd.Timestamp(int(ts_ns[0]), unit="ns", tz="UTC")) if equity.size else "",
        end_ts=str(pd.Timestamp(int(ts_ns[-1]), unit="ns", tz="UTC")) if equity.size else "",
        symbols=list(snap.symbols),
        total_return=ret_block.total_return,
        max_drawdown=dd_block.max_drawdown,
        ann_vol=risk_block.ann_vol,
        ann_sharpe=ratios_block.sharpe,
        total_trades=trade_block.total_trades,
        win_rate=trade_block.win_rate,
        profit_factor=trade_block.profit_factor,
        returns=ret_block, risk=risk_block, ratios=ratios_block,
        drawdown=dd_block, trade=trade_block, exposure=ex_block, stability=stab_block,
        trades=trades_rows, per_symbol=attrib_rows, data_quality=data_quality,
        benchmark=bench_block, monte_carlo=mc_block,
        walk_forward=wf_block, regimes=regimes_block,
    )


def write_artifacts(
    out_dir: Path, results: S.Results, equity: np.ndarray, ts_ns: np.ndarray,
    diagnostics: List[Dict[str, Any]],
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "results.json").write_text(json.dumps(results.to_dict(), indent=2, default=str))
    eq_df = pd.DataFrame({"ts": pd.to_datetime(ts_ns, unit="ns", utc=True), "equity": equity})
    eq_df.to_csv(out_dir / "equity.csv", index=False)
    trades_df = pd.DataFrame([asdict(t) for t in results.trades]) if results.trades else pd.DataFrame()
    trades_df.to_csv(out_dir / "trades.csv", index=False)
    if diagnostics:
        pd.DataFrame(diagnostics).to_csv(out_dir / "diagnostics.csv", index=False)
