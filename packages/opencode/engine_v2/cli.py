"""engine_v2 CLI. Drop-in replacement for backtest.py.

  python -m engine_v2.cli --csv ohlcv.csv --config config.json \
      --interval 15m --capital 10000 [--out results/] [--seed 42] \
      [--mc-paths 1000] [--wf-folds 5]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

import engine_v2
from engine_v2.compat.v1_adapter import make_v1_compat
from engine_v2.core.arrays import MarketSnapshot, from_dataframe
from engine_v2.core.clock import interval_to_rule_and_bars_per_year
from engine_v2.core.rng import derive_seed
from engine_v2.data import quality as DQ
from engine_v2.execution.costs import CostConfig
from engine_v2.execution.fills import FillConfig
from engine_v2.execution.slippage import SlippageConfig
from engine_v2.execution.spread import SpreadConfig
from engine_v2.portfolio.account import Account
from engine_v2.report import emit, schema as S
from engine_v2.robustness.monte_carlo import trade_shuffle
from engine_v2.robustness.regime import classify_bars, breakdown
from engine_v2.runtime.broker import PortfolioBroker
from engine_v2.runtime.loop import run_loop


def _load_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    required = {"timestamp", "open", "high", "low", "close", "volume"}
    missing = sorted(required - set(df.columns))
    if missing:
        raise SystemExit(f"CSV missing required columns: {missing}")
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").reset_index(drop=True)
    keep = ["timestamp", "open", "high", "low", "close", "volume"]
    return df[keep].astype({c: "float64" for c in keep[1:]})


def _resample(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    rule, _ = interval_to_rule_and_bars_per_year(interval)
    d = df.set_index("timestamp").resample(rule, label="left", closed="left").agg({
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum",
    }).dropna().reset_index()
    return d


def _build_broker(snap: MarketSnapshot, cfg: Dict, interval: str, mode: str) -> PortfolioBroker:
    exec_cfg = cfg.get("execution", {})
    risk_cfg = cfg.get("risk", {})
    account = Account.new(
        starting_cash=float(risk_cfg.get("starting_equity_usd", 10000.0)),
        max_leverage=float(exec_cfg.get("max_leverage", 1.0)),
        maintenance_margin_pct=float(exec_cfg.get("maintenance_margin_pct", 0.0)),
    )
    costs = CostConfig(
        maker_fee_bps=float(exec_cfg.get("maker_fee_bps", 2.0)),
        taker_fee_bps=float(exec_cfg.get("taker_fee_bps", 7.0)),
        funding_rate_bps_per_interval=float(exec_cfg.get("funding_rate_bps", 0.0)),
        funding_interval_hours=float(exec_cfg.get("funding_interval_hours", 8.0)),
        short_borrow_rate_annual=float(exec_cfg.get("short_borrow_rate_annual", 0.0)),
    )
    fill_cfg = FillConfig(
        mode=mode,
        participation_pct=float(exec_cfg.get("participation_pct", 0.10 if mode == "v2" else 1.0)),
        slippage=SlippageConfig(
            base_bps=float(exec_cfg.get("slippage_bps", 1.0)),
            k_atr=float(exec_cfg.get("k_atr", 0.5 if mode == "v2" else 0.0)),
            k_vol=float(exec_cfg.get("k_vol", 5.0 if mode == "v2" else 0.0)),
        ),
        spread=SpreadConfig(
            enabled=bool(exec_cfg.get("spread_enabled", False)),
            k=float(exec_cfg.get("spread_k", 0.5)),
            lookback_bars=int(exec_cfg.get("spread_lookback", 30)),
        ),
    )
    return PortfolioBroker(snap, account, costs, fill_cfg, interval=interval)


def _run_strategy(broker: PortfolioBroker, snap: MarketSnapshot,
                  strategy_path: Path, config_path: Path, symbol: str):
    """Load v1 EthTrendBreakout-style strategy via the v1 adapter.

    Future: support v2-native Strategy ABC. For now this is the path because
    the in-tree strategy is v1.
    """
    import importlib.util
    if strategy_path.exists() and strategy_path.name == "strategy.py":
        # Use the repo-root strategy.py which exposes EthTrendBreakoutStrategy
        sys.path.insert(0, str(strategy_path.parent))
        from strategy import EthTrendBreakoutStrategy  # type: ignore
        v1b, v1m = make_v1_compat(snap, broker, symbol)
        return EthTrendBreakoutStrategy(config_path=str(config_path), broker=v1b, market=v1m)
    raise SystemExit(f"Strategy not loadable from {strategy_path}")


def main() -> None:
    ap = argparse.ArgumentParser(prog="engine_v2")
    ap.add_argument("--csv", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--interval", required=True)
    ap.add_argument("--capital", type=float, required=True)
    ap.add_argument("--out", default=".")
    ap.add_argument("--mode", choices=["v2", "v1_compat"], default="v2")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--mc-paths", type=int, default=0,
                    help="If >0, run Monte-Carlo trade-shuffle with N paths")
    ap.add_argument("--regimes", action="store_true")
    ap.add_argument("--start-date", default=None)
    ap.add_argument("--end-date", default=None)
    ap.add_argument("--strategy", default="strategy.py")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    cfg.setdefault("risk", {})["starting_equity_usd"] = float(args.capital)
    symbol = cfg["symbol"]

    df = _load_csv(Path(args.csv))
    if args.start_date:
        df = df[df["timestamp"] >= pd.to_datetime(args.start_date, utc=True)]
    if args.end_date:
        end = pd.to_datetime(args.end_date, utc=True) + pd.Timedelta(days=1)
        df = df[df["timestamp"] < end]
    df = df.reset_index(drop=True)
    if df.empty:
        raise SystemExit("No bars after date filter")

    # Match v1 — resample to interval (CSV may be at different resolution).
    try:
        df = _resample(df, args.interval)
    except ValueError as e:
        raise SystemExit(f"Invalid interval {args.interval!r}: {e}") from e
    except Exception as e:
        raise SystemExit(f"Failed to resample CSV at interval {args.interval!r}: {e}") from e
    if df.empty:
        raise SystemExit("No bars after resampling")

    _, bars_per_year = interval_to_rule_and_bars_per_year(args.interval)

    # Data quality
    asset_class = "crypto" if any(t in symbol.upper() for t in ("USD", "USDT", "/")) else "equity"
    dq = DQ.analyze(df, args.interval, asset_class)

    ba = from_dataframe(df, symbol=symbol, atr_period=14)
    snap = MarketSnapshot({symbol: ba})

    seed = args.seed if args.seed else derive_seed(cfg, str(df["timestamp"].iloc[0]),
                                                   str(df["timestamp"].iloc[-1]),
                                                   args.interval)

    broker = _build_broker(snap, cfg, args.interval, args.mode)
    strat = _run_strategy(broker, snap,
                          Path(args.strategy), Path(args.config), symbol)
    result = run_loop(broker, snap, lambda: strat.on_bar())
    equity = result.equity_curve
    exposure_hist = result.gross_exposure

    # Monte-Carlo
    mc = None
    if args.mc_paths > 0 and broker.book.trades:
        pnls = np.array([t.pnl for t in broker.book.trades])
        mc = trade_shuffle(pnls, args.capital, bars_per_year,
                           n_paths=args.mc_paths, seed=seed)

    # Regimes
    regimes = None
    if args.regimes:
        labels = classify_bars(ba.close, lookback=30)
        regimes = breakdown(equity, labels, ba.ts, broker.book.trades, bars_per_year)

    results = emit.assemble(
        broker=broker, snap=snap, equity=equity, diagnostics=result.diagnostics,
        exposure_history=exposure_hist, starting_equity=args.capital,
        interval=args.interval, bars_per_year=bars_per_year, seed=int(seed),
        schema_engine_version=engine_v2.__version__,
        monte_carlo=mc, regimes=regimes, data_quality=dq,
    )
    emit.write_artifacts(Path(args.out), results, equity, ba.ts, result.diagnostics)

    # Legacy line-format stdout for the existing TS parser fallback path.
    print(f"total_return: {results.total_return}")
    print(f"max_drawdown: {results.max_drawdown}")
    print(f"ann_vol: {results.ann_vol}")
    print(f"ann_sharpe: {results.ann_sharpe}")
    print(f"ending_equity: {results.ending_equity}")
    print(f"total_trades: {results.total_trades}")
    print(f"win_rate: {results.win_rate}")
    print(f"profit_factor: {results.profit_factor}")
    print(f"schema_version: {results.schema_version}")


if __name__ == "__main__":
    main()
