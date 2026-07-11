"""Assemble a Results object from engine outputs + emit results.json /
equity.csv / trades.csv / diagnostics.csv."""

from __future__ import annotations

import json
import math
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from ..core.arrays import MarketSnapshot
from ..execution.fills import Fill
from ..metrics import benchmark as M_benchmark
from ..metrics import consistency as M_consistency
from ..metrics import drawdown as M_dd
from ..metrics import exposure as M_exposure
from ..metrics import ratios as M_ratios
from ..metrics import returns as M_returns
from ..metrics import risk as M_risk
from ..metrics import stability as M_stability
from ..metrics import trade as M_trade
from ..robustness import decay as M_decay
from ..portfolio.attribution import per_symbol
from ..portfolio.positions import ClosedTrade
from ..runtime.broker import PortfolioBroker
from . import schema as S


WALK_FORWARD_ROBUST_RETENTION = 0.7


def _walk_forward_sensitivity_status(walk_forward: Any) -> str:
    """Mirror the TS walk-forward verdict's pass boundary.

    `flagged` carries the canonical failure reasons for schema 3.5+; the
    explicit absolute checks keep this presentation layer fail-closed if it is
    handed an older or partially populated result object.
    """
    decay = getattr(walk_forward, "oos_decay", None)
    stitched_return = getattr(walk_forward, "stitched_oos_return", None)
    stitched_sharpe = getattr(walk_forward, "stitched_oos_sharpe", None)
    coverage = getattr(walk_forward, "stitched_oos_coverage", None)
    ruined_folds = getattr(walk_forward, "ruined_folds", 0)
    n_folds = getattr(walk_forward, "n_folds", 0)
    if not isinstance(n_folds, (int, float)) or float(n_folds) < 2.0:
        return "review"
    if bool(getattr(walk_forward, "flagged", False)):
        return "review"
    if not isinstance(decay, (int, float)) or not math.isfinite(float(decay)):
        return "review"
    if float(decay) < WALK_FORWARD_ROBUST_RETENTION:
        return "review"
    if (
        not isinstance(stitched_return, (int, float))
        or not math.isfinite(float(stitched_return))
        or float(stitched_return) <= 0.0
    ):
        return "review"
    if (
        not isinstance(stitched_sharpe, (int, float))
        or not math.isfinite(float(stitched_sharpe))
        or float(stitched_sharpe) <= 0.0
    ):
        return "review"
    if (
        not isinstance(coverage, (int, float))
        or not math.isfinite(float(coverage))
        or float(coverage) < 0.95
    ):
        return "review"
    if isinstance(ruined_folds, (int, float)) and float(ruined_folds) > 0.0:
        return "review"
    return "pass"


def _sanitize_json(obj: Any, path: str = "") -> tuple[Any, List[Dict[str, str]]]:
    non_finite: List[Dict[str, str]] = []
    if isinstance(obj, float):
        if not math.isfinite(obj):
            return None, [{"path": path or "$", "value": repr(obj)}]
        return obj, []
    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for key, value in obj.items():
            child_path = f"{path}.{key}" if path else str(key)
            sanitized, found = _sanitize_json(value, child_path)
            out[key] = sanitized
            non_finite.extend(found)
        return out, non_finite
    if isinstance(obj, list):
        out_list: List[Any] = []
        for idx, value in enumerate(obj):
            child_path = f"{path}[{idx}]" if path else f"[{idx}]"
            sanitized, found = _sanitize_json(value, child_path)
            out_list.append(sanitized)
            non_finite.extend(found)
        return out_list, non_finite
    return obj, []


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


@dataclass(frozen=True)
class DurabilityBlockInput:
    equity: np.ndarray
    ts_ns: np.ndarray
    returns: np.ndarray
    bars_per_year: float
    walk_forward: Optional[Any]
    rolling_sharpe_series: np.ndarray
    trades: List[ClosedTrade]
    exposure: S.ExposureMetrics


def _build_consistency_block(input: DurabilityBlockInput) -> Optional[S.ConsistencyMetrics]:
    metrics = M_consistency.compute_consistency(
        M_consistency.ConsistencyInput(
            equity=input.equity,
            ts_ns=input.ts_ns,
            returns=input.returns,
            bars_per_year=input.bars_per_year,
            walk_forward=input.walk_forward,
            rolling_sharpe=input.rolling_sharpe_series,
        )
    )
    return S.ConsistencyMetrics(**metrics) if metrics is not None else None


def _build_decay_block(input: DurabilityBlockInput) -> Optional[S.AlphaDecayMetrics]:
    metrics = M_decay.compute_alpha_decay(
        M_decay.AlphaDecayInput(
            rolling_sharpe=input.rolling_sharpe_series,
            ts_ns=input.ts_ns,
            walk_forward=input.walk_forward,
            trades=input.trades,
            exposure=input.exposure,
            window=90,
        )
    )
    if metrics is None:
        return None
    return S.AlphaDecayMetrics(
        mann_kendall=S.MannKendallMetrics(**metrics["mann_kendall"]),
        fold_slope=S.FoldSlopeMetrics(**metrics["fold_slope"]) if metrics.get("fold_slope") else None,
        breakeven=S.BreakevenProjectionMetrics(**metrics["breakeven"]),
        label=metrics["label"],
        confidence=metrics["confidence"],
        reasons=metrics.get("reasons", []),
    )


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
    execution_config: Optional[Dict[str, Any]] = None,
    run_metadata: Optional[Dict[str, Any]] = None,
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
    rolling_sharpe_series = M_stability.rolling_sharpe_series(returns, bars_per_year, window=90)
    if rolling_sharpe_series.size:
        rsh_mean = float(rolling_sharpe_series.mean())
        rsh_min = float(rolling_sharpe_series.min())
    else:
        rsh_mean = 0.0
        rsh_min = 0.0
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
        elif run_metadata is not None:
            if not isinstance(run_metadata.get("benchmark_unavailable_reason"), str):
                run_metadata["benchmark_unavailable_reason"] = (
                    "benchmark metrics unavailable because the strategy/benchmark return series is too short or has insufficient variance"
                )

    # Trades schema
    trades_rows: List[S.TradeRow] = []
    for t in trades:
        multiplier = t.multiplier if t.multiplier else 1.0
        notional = t.entry_price * t.qty * multiplier if t.qty > 0 else 0.0
        pnl_pct = float(t.pnl / notional) if notional > 0 else 0.0
        r_mult = None
        if t.stop_distance is not None and t.stop_distance > 0 and t.qty > 0:
            r_mult = float(t.pnl / (t.stop_distance * t.qty * multiplier))
        trades_rows.append(S.TradeRow(
            symbol=t.symbol, side=t.side,
            entry_ts=str(pd.Timestamp(int(t.entry_ts_ns), unit="ns", tz="UTC")),
            exit_ts=str(pd.Timestamp(int(t.exit_ts_ns), unit="ns", tz="UTC")),
            qty=t.qty, entry_price=t.entry_price, exit_price=t.exit_price,
            multiplier=multiplier, pnl=t.pnl, pnl_pct=pnl_pct, r_multiple=r_mult,
            fees=t.fees, funding=t.funding, borrow=t.borrow,
            mae=t.mae, mfe=t.mfe, hold_bars=t.hold_bars,
            entry_tag=t.entry_tag, exit_tag=t.exit_tag, liquidation=t.liquidation,
        ))
    open_trade_rows: List[S.OpenTradeRow] = []
    for sym, pos in broker.book.positions.items():
        if pos.qty == 0:
            continue
        mark = float(broker.account.last_prices.get(sym, pos.avg_price))
        side = pos.side_at_open or ("long" if pos.qty > 0 else "short")
        open_trade_rows.append(S.OpenTradeRow(
            symbol=sym,
            side=side,
            qty=abs(float(pos.qty)),
            entry_ts=str(pd.Timestamp(int(pos.entry_ts_ns), unit="ns", tz="UTC")),
            entry_price=float(pos.entry_price),
            mark_price=mark,
            multiplier=float(pos.multiplier or 1.0),
            unrealized_pnl=float(pos.unrealized_pnl(mark)),
            fees_accrued=float(pos.fees_accum),
            funding_accrued=float(pos.funding_accum),
            borrow_accrued=float(pos.borrow_accum),
            hold_bars=int(pos.bars_held),
            entry_tag=pos.entry_tag,
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
            outlier_details=[
                S.OutlierDetail(
                    timestamp=d.timestamp,
                    previous_close=d.previous_close,
                    current_close=d.current_close,
                    log_return=d.log_return,
                    z_score=d.z_score,
                    provider=d.provider,
                )
                for d in getattr(data_quality, "outlier_details", [])
            ],
            repaired_outliers=getattr(data_quality, "repaired_outliers", 0),
            repair_applied=getattr(data_quality, "repair_applied", False),
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
            is_to_oos_sharpe_change=walk_forward.is_to_oos_sharpe_change,
            flag_threshold=walk_forward.flag_threshold,
            flagged=walk_forward.flagged,
            deflated_sharpe=walk_forward.deflated_sharpe,
            probabilistic_sharpe=walk_forward.probabilistic_sharpe,
            stitched_oos_return=walk_forward.stitched_oos_return,
            stitched_oos_sharpe=walk_forward.stitched_oos_sharpe,
            stitched_oos_trades=walk_forward.stitched_oos_trades,
            stitched_oos_bars=walk_forward.stitched_oos_bars,
            stitched_oos_coverage=walk_forward.stitched_oos_coverage,
            ruined_folds=walk_forward.ruined_folds,
            multiple_testing_trials=walk_forward.multiple_testing_trials,
            folds=[
                S.WalkForwardFold(
                    fold=f.fold,
                    train_start=str(pd.Timestamp(f.train_start_ns, unit="ns", tz="UTC")),
                    train_end=str(pd.Timestamp(f.train_end_ns, unit="ns", tz="UTC")),
                    test_start=str(pd.Timestamp(f.test_start_ns, unit="ns", tz="UTC")),
                    test_end=str(pd.Timestamp(f.test_end_ns, unit="ns", tz="UTC")),
                    is_sharpe=f.is_sharpe, oos_sharpe=f.oos_sharpe,
                    is_return=f.is_return, oos_return=f.oos_return,
                    oos_trades=f.oos_trades, oos_bars=f.oos_bars,
                    oos_coverage=f.oos_coverage, oos_max_drawdown=f.oos_max_drawdown,
                    ruined=f.ruined, selected_params=f.selected_params,
                )
                for f in walk_forward.folds
            ],
            flag_reasons=list(getattr(walk_forward, "flag_reasons", [])),
        )

    regimes_block = None
    if regimes is not None:
        regimes_block = [S.RegimeBreakdown(**asdict(r)) for r in regimes]
    durability_input = DurabilityBlockInput(
        equity=equity,
        ts_ns=ts_ns,
        returns=returns,
        bars_per_year=bars_per_year,
        walk_forward=walk_forward,
        rolling_sharpe_series=rolling_sharpe_series,
        trades=trades,
        exposure=ex_block,
    )
    consistency_block = _build_consistency_block(durability_input)
    decay_block = _build_decay_block(durability_input)
    asset_spec_block = None
    if run_metadata and isinstance(run_metadata.get("asset_spec"), dict):
        asset_spec_block = S.AssetSpecReport(**{
            k: v for k, v in run_metadata["asset_spec"].items()
            if k in S.AssetSpecReport.__dataclass_fields__
        })
    margin_used = float(broker.account.required_initial_margin(broker.book.positions))
    free_margin = float(broker.account.free_margin(broker.book.positions))
    mtm_nav = float(equity[-1]) if equity.size else float(starting_equity)
    start_ts = str(pd.Timestamp(int(ts_ns[0]), unit="ns", tz="UTC")) if equity.size else ""
    end_ts = str(pd.Timestamp(int(ts_ns[-1]), unit="ns", tz="UTC")) if equity.size else ""
    margin_stress_enabled = (
        broker.account.max_leverage > 1.0 and broker.account.maintenance_margin_pct > 0.0
    )
    if margin_stress_enabled:
        liquidation_nav = max(0.0, mtm_nav - max(0.0, margin_used - free_margin))
    else:
        liquidation_nav = mtm_nav
    total_costs = float(ex_block.total_fees + ex_block.total_funding + ex_block.total_borrow)
    profile_id = f"{schema_engine_version}:{seed}:{','.join(snap.symbols)}:{interval}:{start_ts}:{end_ts}"
    sens: List[S.SensitivityOutcome] = []
    if mc_block is not None:
        sens.append(S.SensitivityOutcome(
            name="Monte Carlo",
            status="pass" if mc_block.sharpe_p5 >= 0 and mc_block.max_dd_p95 > -0.35 else "review",
            value=mc_block.sharpe_p5,
            explanation="Trade-path resampling checks whether the edge survives sequence risk.",
        ))
    if wf_block is not None:
        sens.append(S.SensitivityOutcome(
            name="Walk-forward",
            status=_walk_forward_sensitivity_status(wf_block),
            value=wf_block.oos_decay,
            explanation="Out-of-sample folds compare live-like performance against in-sample fit.",
        ))
    if regimes_block is not None:
        worst_regime = min((r.total_return for r in regimes_block), default=0.0)
        sens.append(S.SensitivityOutcome(
            name="Regime split",
            status="pass" if worst_regime >= 0 else "review",
            value=worst_regime,
            explanation="Volatility-regime slices show whether one market state carries the result.",
        ))

    return S.Results(
        schema_version=S.SCHEMA_VERSION,
        engine_version=schema_engine_version,
        seed=seed,
        starting_equity=float(starting_equity),
        ending_equity=float(equity[-1]) if equity.size else float(starting_equity),
        bars_processed=int(equity.size),
        interval=interval,
        start_ts=start_ts,
        end_ts=end_ts,
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
        trades=trades_rows, open_trades=open_trade_rows, per_symbol=attrib_rows, data_quality=data_quality,
        benchmark=bench_block, monte_carlo=mc_block,
        walk_forward=wf_block, consistency=consistency_block,
        alpha_decay=decay_block, regimes=regimes_block,
        execution_config=execution_config,
        diagnostics={
            **broker.diagnostics(),
            "bar_diagnostics_count": len(diagnostics),
            "margin_used": margin_used,
            "free_margin": free_margin,
        },
        run_metadata=run_metadata,
        asset_spec=asset_spec_block,
        nav_summary=S.NavSummary(
            mark_to_market_nav=mtm_nav,
            liquidation_nav=liquidation_nav,
            explanation="Mark-to-market NAV prices open positions at the last available mark; liquidation NAV also reserves margin stress for positions that could be forced closed.",
        ),
        cost_attribution=S.CostAttributionSummary(
            total_costs=total_costs,
            fees=float(ex_block.total_fees),
            funding=float(ex_block.total_funding),
            borrow=float(ex_block.total_borrow),
            cost_as_pct_starting_equity=float(total_costs / starting_equity) if starting_equity else 0.0,
            explanation="Costs include commissions/fees, funding, and borrow charges applied by the Crucible 2.0 execution model.",
        ),
        profile_identity=S.ProfileIdentity(
            product_label="Crucible 2.0",
            profile_id=profile_id,
            strategy_hash=str(run_metadata.get("strategy_hash")) if run_metadata and run_metadata.get("strategy_hash") is not None else None,
            config_hash=str(run_metadata.get("config_hash")) if run_metadata and run_metadata.get("config_hash") is not None else None,
            data_hash=str(run_metadata.get("data_hash")) if run_metadata and run_metadata.get("data_hash") is not None else None,
            explanation="Profile identity binds the strategy, config, data, engine, seed, symbols, and interval for immutable reruns.",
        ),
        sensitivity_outcomes=sens,
        explanations=S.ResultExplanations(
            product="Crucible 2.0 is the strict next-open engine path; legacy unsafe runs remain labeled separately.",
            mark_to_market_nav="Mark-to-market NAV is cash plus unrealized P&L at the latest bar mark.",
            liquidation_nav="Liquidation NAV is the stress NAV after reserving margin pressure for forced-close risk.",
            cost_attribution="Cost attribution separates fees, funding, and borrow from trading P&L.",
            profile_identity="Profile identity shows the immutable run fingerprint used for comparison and reruns.",
            sensitivity_outcomes="Sensitivity outcomes summarize Monte Carlo, walk-forward, and regime checks when requested.",
        ),
    )


def write_artifacts(
    out_dir: Path, results: S.Results, equity: np.ndarray, ts_ns: np.ndarray,
    diagnostics: List[Dict[str, Any]], broker: Optional[PortfolioBroker] = None,
    bars_per_year: Optional[float] = None,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    results_dict = results.to_dict()
    sanitized, non_finite = _sanitize_json(results_dict)
    if non_finite:
        diagnostics_map = sanitized.setdefault("diagnostics", {})
        if not isinstance(diagnostics_map, dict):
            diagnostics_map = {}
            sanitized["diagnostics"] = diagnostics_map
        diagnostics_map["non_finite_metrics"] = non_finite
    (out_dir / "results.json").write_text(json.dumps(sanitized, indent=2, default=str, allow_nan=False))
    eq_df = pd.DataFrame({"ts": pd.to_datetime(ts_ns, unit="ns", utc=True), "equity": equity})
    eq_df.to_csv(out_dir / "equity.csv", index=False)
    returns = M_returns.bar_returns(equity)
    rolling = M_stability.rolling_sharpe_series(
        returns,
        float(bars_per_year) if bars_per_year is not None else 252.0,
        window=results.stability.rolling_sharpe_window,
    )
    if rolling.size and ts_ns.size >= results.stability.rolling_sharpe_window + rolling.size:
        rolling_ts = ts_ns[results.stability.rolling_sharpe_window:results.stability.rolling_sharpe_window + rolling.size]
        pd.DataFrame({
            "ts": pd.to_datetime(rolling_ts, unit="ns", utc=True),
            "rolling_sharpe": rolling,
        }).to_csv(out_dir / "rolling_sharpe.csv", index=False)
    else:
        pd.DataFrame(columns=["ts", "rolling_sharpe"]).to_csv(out_dir / "rolling_sharpe.csv", index=False)
    trades_df = pd.DataFrame([asdict(t) for t in results.trades]) if results.trades else pd.DataFrame()
    trades_df.to_csv(out_dir / "trades.csv", index=False)
    fills_df = pd.DataFrame([asdict(f) for f in broker.fills_log]) if broker is not None and broker.fills_log else pd.DataFrame()
    if broker is not None and (results.trades or results.open_trades) and fills_df.empty:
        raise RuntimeError("execution artifact invariant failed: positions/trades exist but fills.csv would be empty")
    fills_df.to_csv(out_dir / "fills.csv", index=False)
    rejections = []
    if results.diagnostics and isinstance(results.diagnostics.get("rejections"), list):
        rejections = results.diagnostics.get("rejections") or []
    pd.DataFrame(rejections).to_csv(out_dir / "rejections.csv", index=False)
    orders_rows = broker.order_audit_rows() if broker is not None else []
    if broker is not None and (results.trades or results.open_trades) and not orders_rows:
        raise RuntimeError("execution artifact invariant failed: positions/trades exist but orders.csv would be empty")
    pd.DataFrame(orders_rows).to_csv(out_dir / "orders.csv", index=False)
    if diagnostics:
        pd.DataFrame(diagnostics).to_csv(out_dir / "diagnostics.csv", index=False)
