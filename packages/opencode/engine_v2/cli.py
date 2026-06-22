"""engine_v2 CLI. Drop-in replacement for backtest.py.

  python -m engine_v2.cli --csv ohlcv.csv --config config.json \
      --interval 15m --capital 10000 [--out results/] [--seed 42] \
      [--mc-paths 1000] [--wf-folds 5]
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import inspect
import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

import engine_v2
from engine_v2.assets import AssetSpec, resolve_asset_spec
from engine_v2.compat.shapec_adapter import ShapeCBrokerAdapter
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
from engine_v2.robustness.regime import classify_bars, classify_trend, breakdown
from engine_v2.robustness.walkforward import run_walk_forward
from engine_v2.metrics import ratios as M_ratios
from engine_v2.metrics import returns as M_returns
from engine_v2.metrics import drawdown as M_drawdown
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


def _quality_failure(
    prefix: str,
    reasons: List[str],
    report: DQ.QualityReport,
    *,
    provider: str,
    symbol: str,
    interval: str,
    raw_rows: int,
    post_rows: Optional[int] = None,
) -> str:
    fields = [
        f"provider={provider}",
        f"symbol={symbol}",
        f"interval={interval}",
        f"raw_rows={raw_rows}",
    ]
    if post_rows is not None:
        fields.append(f"post_resample_rows={post_rows}")
    fields.extend([
        f"coverage={report.coverage_pct:.2%}",
        f"gaps={report.gap_count}",
        f"duplicates={report.duplicate_ts_count}",
        f"invalid_ohlc={report.ohlc_violations}",
        f"outliers={report.outlier_bars}",
        f"zero_volume={report.zero_volume_bars}",
    ])
    detail_lines = []
    for d in report.outlier_details[:5]:
        detail_lines.append(
            f"outlier ts={d.timestamp} prev_close={d.previous_close:.6g} "
            f"close={d.current_close:.6g} log_return={d.log_return:.6g} "
            f"z={d.z_score:.2f} provider={d.provider}"
        )
    suffix = "\n" + "\n".join(detail_lines) if detail_lines else ""
    return f"{prefix}: {'; '.join(reasons)} ({', '.join(fields)}){suffix}"


def _resample(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    rule, _ = interval_to_rule_and_bars_per_year(interval)
    d = df.set_index("timestamp").resample(rule, label="left", closed="left").agg({
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum",
    }).dropna().reset_index()
    return d


def _apply_regular_hours_filter(df: pd.DataFrame, asset_class: str, cfg: Dict, interval: str) -> pd.DataFrame:
    exec_cfg = cfg.get("execution", {}) if isinstance(cfg.get("execution"), dict) else {}
    if bool(exec_cfg.get("extended_hours", False)):
        return df
    if asset_class not in {"equity", "option"}:
        return df
    if not DQ.is_intraday_interval(interval):
        return df
    if df.empty:
        return df

    ts_et = pd.to_datetime(df["timestamp"], utc=True).dt.tz_convert("America/New_York")
    minutes = ts_et.dt.hour * 60 + ts_et.dt.minute
    in_regular_session = (
        (ts_et.dt.weekday < 5)
        & (minutes >= 9 * 60 + 30)
        & (minutes < 16 * 60)
    )
    return df.loc[in_regular_session].reset_index(drop=True)


def _build_broker(snap: MarketSnapshot, cfg: Dict, interval: str, mode: str, asset_spec: AssetSpec) -> PortfolioBroker:
    exec_cfg = cfg.get("execution", {})
    risk_cfg = cfg.get("risk", {})
    default_initial_margin = (
        float(asset_spec.initialMarginPct)
        if asset_spec.initialMarginPct is not None
        else float(exec_cfg.get("initial_margin_pct", 1.0) or 1.0)
    )
    max_leverage = float(exec_cfg.get("max_leverage", 1.0))
    if asset_spec.assetClass in {"crypto_perp", "future"} and "max_leverage" not in exec_cfg:
        max_leverage = 1.0 / default_initial_margin if default_initial_margin > 0 else 1.0
    account = Account.new(
        starting_cash=float(risk_cfg.get("starting_equity_usd", 10000.0)),
        max_leverage=max_leverage,
        maintenance_margin_pct=float(
            exec_cfg.get(
                "maintenance_margin_pct",
                asset_spec.maintenanceMarginPct if asset_spec.maintenanceMarginPct is not None else 0.0,
            )
        ),
    )
    costs = CostConfig(
        maker_fee_bps=float(exec_cfg.get("maker_fee_bps", 2.0)),
        taker_fee_bps=float(exec_cfg.get("taker_fee_bps", 7.0)),
        commission_per_contract=float(
            exec_cfg.get(
                "commission_per_contract",
                asset_spec.commissionPerContract if asset_spec.commissionPerContract is not None else 0.0,
            )
        ),
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
            enabled=bool(exec_cfg.get("spread_enabled", asset_spec.productionEligible)),
            k=float(exec_cfg.get("spread_k", 0.5)),
            lookback_bars=int(exec_cfg.get("spread_lookback", 30)),
        ),
    )
    return PortfolioBroker(snap, account, costs, fill_cfg, interval=interval, asset_specs={asset_spec.symbol: asset_spec})


def _execution_config(cfg: Dict, mode: str, asset_spec: AssetSpec) -> Dict[str, Any]:
    exec_cfg = cfg.get("execution", {})
    default_initial_margin = (
        float(asset_spec.initialMarginPct)
        if asset_spec.initialMarginPct is not None
        else float(exec_cfg.get("initial_margin_pct", 1.0) or 1.0)
    )
    default_maintenance_margin = (
        float(asset_spec.maintenanceMarginPct)
        if asset_spec.maintenanceMarginPct is not None
        else float(exec_cfg.get("maintenance_margin_pct", 0.0))
    )
    max_leverage = float(exec_cfg.get("max_leverage", 1.0))
    if asset_spec.assetClass in {"crypto_perp", "future"} and "max_leverage" not in exec_cfg:
        max_leverage = 1.0 / default_initial_margin if default_initial_margin > 0 else 1.0
    return {
        "fill_model": "engine_v2.next_open" if mode == "v2" else "engine_v2.v1_compat",
        "participation_pct": float(exec_cfg.get("participation_pct", 0.10 if mode == "v2" else 1.0)),
        "maker_fee_bps": float(exec_cfg.get("maker_fee_bps", 2.0)),
        "taker_fee_bps": float(exec_cfg.get("taker_fee_bps", 7.0)),
        "commission_per_contract": float(
            exec_cfg.get(
                "commission_per_contract",
                asset_spec.commissionPerContract if asset_spec.commissionPerContract is not None else 0.0,
            )
        ),
        "slippage_bps": float(exec_cfg.get("slippage_bps", 1.0)),
        "k_atr": float(exec_cfg.get("k_atr", 0.5 if mode == "v2" else 0.0)),
        "k_vol": float(exec_cfg.get("k_vol", 5.0 if mode == "v2" else 0.0)),
        "spread_enabled": bool(exec_cfg.get("spread_enabled", asset_spec.productionEligible)),
        "spread_k": float(exec_cfg.get("spread_k", 0.5)),
        "spread_lookback": int(exec_cfg.get("spread_lookback", 30)),
        "max_leverage": max_leverage,
        "initial_margin_pct": float(exec_cfg.get("initial_margin_pct", default_initial_margin)),
        "maintenance_margin_pct": float(exec_cfg.get("maintenance_margin_pct", default_maintenance_margin)),
        "funding_enabled": float(exec_cfg.get("funding_rate_bps", 0.0)) != 0.0,
        "funding_rate_bps": float(exec_cfg.get("funding_rate_bps", 0.0)),
        "funding_interval_hours": float(exec_cfg.get("funding_interval_hours", 8.0)),
        "liquidation_enabled": max_leverage > 1.0 and default_maintenance_margin > 0.0,
        "asset_class": asset_spec.assetClass,
        "multiplier": asset_spec.multiplier,
        "tick_size": asset_spec.tickSize,
        "lot_size": asset_spec.lotSize,
    }


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _data_hash(df: pd.DataFrame) -> str:
    payload = df[["timestamp", "open", "high", "low", "close", "volume"]].to_csv(index=False).encode("utf-8")
    return _sha256_bytes(payload)


def _run_strategy(broker: PortfolioBroker, snap: MarketSnapshot,
                  strategy_path: Path, config_path: Path, symbol: str,
                  params: Any = None) -> Tuple[Any, str]:
    """Load a strategy from *strategy_path*, auto-detecting its shape.

    Returns ``(strategy_instance, shape)`` where *shape* is ``"shapec"`` for
    the canonical Shape-C contract or ``"v1"`` for legacy EthTrendBreakout.
    """
    if not strategy_path.exists():
        raise SystemExit(f"Strategy file not found: {strategy_path}")

    spec = importlib.util.spec_from_file_location("_user_strategy", strategy_path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(strategy_path.parent))
    spec.loader.exec_module(mod)

    # Shape-C: module exposes a ``Strategy`` class whose first __init__
    # param (after self) is ``broker``.
    strategy_cls = getattr(mod, "Strategy", None)
    if strategy_cls is not None:
        sig = inspect.signature(strategy_cls.__init__)
        init_params = [p for p in sig.parameters if p != "self"]
        if init_params and init_params[0] == "broker":
            adapter = ShapeCBrokerAdapter(broker, snap, symbol)
            accepts_params = "params" in sig.parameters
            if accepts_params and params is not None:
                strat = strategy_cls(adapter, params=params)
            else:
                strat = strategy_cls(adapter)
            return strat, "shapec"

    # v1 fallback: module exposes EthTrendBreakoutStrategy.
    # Import lazily — v1_adapter's top-level `from strategy import ...` will
    # fail if the tmpdir's strategy.py is Shape-C (no Broker/MarketData classes).
    v1_cls = getattr(mod, "EthTrendBreakoutStrategy", None)
    if v1_cls is not None:
        from engine_v2.compat.v1_adapter import make_v1_compat
        v1b, v1m = make_v1_compat(snap, broker, symbol)
        return v1_cls(config_path=str(config_path), broker=v1b, market=v1m), "v1"

    names = [n for n in dir(mod) if not n.startswith("_")]
    raise SystemExit(
        f"Cannot load strategy from {strategy_path}. "
        f"Expected a Shape-C 'Strategy' class or v1 'EthTrendBreakoutStrategy'. "
        f"Found: {', '.join(names[:10])}"
    )


class StrictStrategyWorker:
    RESPONSE_TIMEOUT_S = 2.0
    STARTUP_TIMEOUT_S = 10.0
    RESPONSE_MAX_BYTES = 1_000_000
    MAX_ORDERS_PER_BAR = 100

    def __init__(self, strategy_path: Path, params: Any):
        env = dict(os.environ)
        pythonpath = env.get("PYTHONPATH", "")
        root = str(Path(__file__).resolve().parents[1])
        env["PYTHONPATH"] = root if not pythonpath else f"{root}{os.pathsep}{pythonpath}"
        env["PYTHONHASHSEED"] = str(env.get("FINNY_SEED", "0"))
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "engine_v2.runtime.strategy_worker",
                "--strategy",
                str(strategy_path),
                "--params-json",
                json.dumps(params, allow_nan=False),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            env=env,
        )
        self._read_buffer = b""
        ready = self._read(timeout_s=self.STARTUP_TIMEOUT_S)
        if ready.get("type") != "ready":
            self.close()
            raise SystemExit(f"Strategy worker failed: {ready.get('message', ready)}")

    def _stderr_tail(self, max_bytes: int = 4000) -> str:
        if self.proc.stderr is None:
            return ""
        try:
            ready, _, _ = select.select([self.proc.stderr], [], [], 0)
            if not ready:
                return ""
            data = os.read(self.proc.stderr.fileno(), max_bytes)
            return data.decode("utf-8", errors="replace")[-max_bytes:]
        except Exception:
            return ""

    def _kill(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:
                pass

    def _read(self, timeout_s: float = RESPONSE_TIMEOUT_S) -> Dict[str, Any]:
        if self.proc.stdout is None:
            raise SystemExit("Strategy worker stdout unavailable")
        deadline = time.monotonic() + timeout_s
        while b"\n" not in self._read_buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._kill()
                tail = self._stderr_tail()
                raise SystemExit(f"Strategy worker timed out after {timeout_s:.1f}s waiting for protocol response. {tail}".strip())
            ready, _, _ = select.select([self.proc.stdout], [], [], remaining)
            if not ready:
                continue
            chunk = os.read(self.proc.stdout.fileno(), min(65536, self.RESPONSE_MAX_BYTES + 1 - len(self._read_buffer)))
            if not chunk:
                tail = self._stderr_tail()
                raise SystemExit(f"Strategy worker exited without protocol response. {tail}".strip())
            self._read_buffer += chunk
            if len(self._read_buffer) > self.RESPONSE_MAX_BYTES:
                self._kill()
                raise SystemExit(f"Strategy worker protocol response exceeded {self.RESPONSE_MAX_BYTES} bytes")
        raw, self._read_buffer = self._read_buffer.split(b"\n", 1)
        line = raw.decode("utf-8", errors="replace")
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Strategy worker protocol violation: non-JSON stdout: {line[:200]!r}") from exc
        if not isinstance(msg, dict):
            raise SystemExit("Strategy worker protocol violation: message is not an object")
        if msg.get("type") == "error":
            detail = msg.get("message", "unknown worker error")
            trace = msg.get("trace", "")
            raise SystemExit(f"Strategy worker error: {detail}\n{trace}")
        return msg

    def on_bar(self, *, symbol: str, bar: Dict[str, object], state: Dict[str, Any],
               history: Dict[str, Any]) -> List[Dict[str, Any]]:
        if self.proc.stdin is None:
            raise SystemExit("Strategy worker stdin unavailable")
        self.proc.stdin.write((json.dumps({
            "type": "bar",
            "symbol": symbol,
            "bar": bar,
            "state": state,
            "history": history,
        }, allow_nan=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        msg = self._read()
        if msg.get("type") != "result":
            raise SystemExit(f"Strategy worker protocol violation: expected result, got {msg.get('type')!r}")
        orders = msg.get("orders", [])
        if not isinstance(orders, list):
            raise SystemExit("Strategy worker protocol violation: orders is not a list")
        if len(orders) > self.MAX_ORDERS_PER_BAR:
            raise SystemExit(f"Strategy worker emitted {len(orders)} orders in one bar; max is {self.MAX_ORDERS_PER_BAR}")
        return [self._validate_order(o, idx, symbol) for idx, o in enumerate(orders)]

    @staticmethod
    def _validate_order(order: Any, idx: int, default_symbol: str) -> Dict[str, Any]:
        if not isinstance(order, dict):
            raise SystemExit(f"Strategy worker protocol violation: order[{idx}] is not an object")
        side = order.get("side")
        if side not in {"buy", "sell"}:
            raise SystemExit(f"Strategy worker protocol violation: order[{idx}].side must be 'buy' or 'sell'")
        symbol = order.get("symbol", default_symbol)
        if not isinstance(symbol, str) or not symbol:
            raise SystemExit(f"Strategy worker protocol violation: order[{idx}].symbol must be a non-empty string")
        qty = order.get("qty")
        notional = order.get("notional")
        if qty is None and notional is None:
            raise SystemExit(f"Strategy worker protocol violation: order[{idx}] must include qty or notional")
        if qty is not None:
            try:
                qty_num = float(qty)
            except Exception as exc:
                raise SystemExit(f"Strategy worker protocol violation: order[{idx}].qty must be a positive finite number") from exc
            if not np.isfinite(qty_num) or qty_num <= 0:
                raise SystemExit(f"Strategy worker protocol violation: order[{idx}].qty must be a positive finite number")
        if notional is not None:
            try:
                notional_num = float(notional)
            except Exception as exc:
                raise SystemExit(f"Strategy worker protocol violation: order[{idx}].notional must be a positive finite number") from exc
            if not np.isfinite(notional_num) or notional_num <= 0:
                raise SystemExit(f"Strategy worker protocol violation: order[{idx}].notional must be a positive finite number")
        tag = order.get("tag", "")
        if not isinstance(tag, str):
            raise SystemExit(f"Strategy worker protocol violation: order[{idx}].tag must be a string")
        return {
            "side": side,
            "symbol": symbol,
            "qty": qty,
            "notional": notional,
            "tag": tag,
        }

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                if self.proc.stdin:
                    self.proc.stdin.write((json.dumps({"type": "stop"}) + "\n").encode("utf-8"))
                    self.proc.stdin.flush()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def _broker_state(broker: PortfolioBroker, snap: MarketSnapshot, symbol: str) -> Dict[str, Any]:
    state: Dict[str, Any] = {
        "positions": {s: float(broker.book.get(s).qty) for s in snap.symbols},
        "cash": float(broker.account.cash),
        "equity": float(broker.get_equity()),
        "prices": {s: float(broker.latest_price(s)) for s in snap.symbols},
    }
    greeks_map: Dict[str, Any] = {}
    underlying_map: Dict[str, Any] = {}
    dte_map: Dict[str, float] = {}
    for s in snap.symbols:
        g = broker.greeks(s)
        if any(v != 0.0 for v in g.values()):
            greeks_map[s] = g
        up = broker.underlying_price(s)
        if up is not None:
            underlying_map[s] = up
        dte = broker.days_to_expiry(s)
        if dte != float("inf"):
            dte_map[s] = dte
    if greeks_map:
        state["greeks"] = greeks_map
    if underlying_map:
        state["underlying_prices"] = underlying_map
    if dte_map:
        state["dte"] = dte_map
    return state


def _submit_worker_intents(broker: PortfolioBroker, intents: List[Dict[str, Any]], symbol: str) -> None:
    for intent in intents:
        side = intent.get("side")
        intent_symbol = str(intent.get("symbol", symbol))
        qty = intent.get("qty")
        notional = intent.get("notional")
        broker.submit_intent(
            side=str(side),
            symbol=intent_symbol,
            qty=None if qty is None else float(qty),
            notional=None if notional is None else float(notional),
            tag=str(intent.get("tag", "")),
        )


def _run_shapec_strict_worker(
    broker: PortfolioBroker,
    snap: MarketSnapshot,
    strategy_path: Path,
    symbol: str,
    params: Any,
):
    worker = StrictStrategyWorker(strategy_path, params)
    try:
        def callback():
            bar = snap.decision_safe_bar(symbol)
            intents = worker.on_bar(
                symbol=symbol,
                bar=bar,
                state=_broker_state(broker, snap, symbol),
                history={s: list(snap.history_records(s, 500)) for s in snap.symbols},
            )
            _submit_worker_intents(broker, intents, symbol)
            return {}
        return run_loop(broker, snap, callback)
    finally:
        worker.close()


def _param_grid_from_json(raw: Optional[str]) -> Optional[List[Dict[str, Any]]]:
    if not raw:
        return None
    parsed = json.loads(raw)
    if isinstance(parsed, list):
        return [dict(item) for item in parsed if isinstance(item, dict)]
    if not isinstance(parsed, dict):
        raise SystemExit("--param-grid-json must be an object or array of objects")
    combos: List[Dict[str, Any]] = [{}]
    for key, values in parsed.items():
        if not isinstance(values, list) or len(values) == 0:
            raise SystemExit(f"param grid key {key!r} must map to a non-empty list")
        next_combos: List[Dict[str, Any]] = []
        for combo in combos:
            for value in values:
                next_combos.append({**combo, str(key): value})
        combos = next_combos
    return combos


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
    ap.add_argument("--wf-folds", type=int, default=0,
                    help="If >0, run N rolling walk-forward folds")
    ap.add_argument("--param-grid-json", default=None,
                    help="JSON parameter grid for true fold-local walk-forward optimization")
    ap.add_argument("--data-quality-mode", choices=["strict", "repair_outliers"], default="strict")
    ap.add_argument("--regimes", action="store_true")
    ap.add_argument("--start-date", default=None)
    ap.add_argument("--end-date", default=None)
    ap.add_argument("--strategy", default="strategy.py")
    args = ap.parse_args()
    if not np.isfinite(args.capital) or args.capital <= 0:
        raise SystemExit(f"capital must be a positive finite number, got {args.capital!r}")

    cfg = json.loads(Path(args.config).read_text())
    cfg.setdefault("risk", {})["starting_equity_usd"] = float(args.capital)
    required_history_bars_raw = cfg.get("required_history_bars")
    required_history_bars = 0
    if required_history_bars_raw is not None:
        try:
            required_history_bars = int(required_history_bars_raw)
        except (TypeError, ValueError):
            raise SystemExit("required_history_bars must be a non-negative integer")
        if required_history_bars < 0:
            raise SystemExit("required_history_bars must be a non-negative integer")
    if args.wf_folds and args.wf_folds >= 2 and required_history_bars_raw is None:
        raise SystemExit("Walk-forward robustness requires config.required_history_bars")
    param_grid = _param_grid_from_json(args.param_grid_json)
    symbol = cfg["symbol"]
    asset_spec = resolve_asset_spec(cfg)
    if asset_spec.assetClass == "option" and os.environ.get("FINNY_ALLOW_EXPERIMENTAL_OPTIONS") != "1":
        raise SystemExit(f"Options backtests are blocked: {asset_spec.blockingReason}")

    df = _load_csv(Path(args.csv))
    if args.start_date:
        df = df[df["timestamp"] >= pd.to_datetime(args.start_date, utc=True)]
    if args.end_date:
        end = pd.to_datetime(args.end_date, utc=True) + pd.Timedelta(days=1)
        df = df[df["timestamp"] < end]
    df = df.reset_index(drop=True)
    if df.empty:
        raise SystemExit("No bars after date filter")
    raw_rows = int(len(df))
    df = _apply_regular_hours_filter(df, asset_spec.assetClass, cfg, args.interval)
    if df.empty:
        raise SystemExit("No bars after regular-hours filter")
    provider = str(asset_spec.dataProvider or cfg.get("data_provider") or "unknown")
    repaired_details_total = []
    raw_dq = DQ.analyze(df, args.interval, asset_spec.assetClass, provider=provider)
    raw_blocking = [
        reason for reason in DQ.blocking_reasons(raw_dq, asset_spec.assetClass)
        if "duplicate timestamp" in reason or "invalid OHLC" in reason or "severe outlier" in reason
    ]
    if raw_blocking:
        can_repair_raw = (
            args.data_quality_mode == "repair_outliers"
            and raw_dq.outlier_bars > 0
            and raw_dq.duplicate_ts_count == 0
            and raw_dq.ohlc_violations == 0
            and all("severe outlier" in reason for reason in raw_blocking)
        )
        if can_repair_raw:
            repaired_df, repaired_details = DQ.repair_isolated_outliers(
                df,
                provider=provider,
                interval=args.interval,
                asset_class=asset_spec.assetClass,
            )
            if repaired_details and len(repaired_df) < len(df):
                repaired_details_total.extend(repaired_details)
                df = repaired_df
                raw_dq = DQ.report_with_repair(
                    DQ.analyze(df, args.interval, asset_spec.assetClass, provider=provider),
                    repaired_details,
                )
                raw_blocking = [
                    reason for reason in DQ.blocking_reasons(raw_dq, asset_spec.assetClass)
                    if "duplicate timestamp" in reason or "invalid OHLC" in reason or "severe outlier" in reason
                ]
        if raw_blocking:
            for d in raw_dq.outlier_details[:5]:
                print(
                    f"__FINNY_OUTLIER__: ts={d.timestamp} prev_close={d.previous_close} "
                    f"close={d.current_close} log_return={d.log_return} z={d.z_score:.2f} provider={provider}",
                    file=sys.stderr,
                )
            raise SystemExit(_quality_failure(
                "Data quality failed before resample",
                raw_blocking,
                raw_dq,
                provider=provider,
                symbol=str(symbol),
                interval=str(args.interval),
                raw_rows=raw_rows,
            ))

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

    # Data quality is a hard gate for strict engine runs.
    dq = DQ.analyze(df, args.interval, asset_spec.assetClass, provider=provider)
    if repaired_details_total:
        dq = DQ.report_with_repair(dq, repaired_details_total)
    blocking_quality = DQ.blocking_reasons(dq, asset_spec.assetClass)
    if blocking_quality:
        can_repair = (
            args.data_quality_mode == "repair_outliers"
            and dq.outlier_bars > 0
            and dq.duplicate_ts_count == 0
            and dq.ohlc_violations == 0
            and all("severe outlier" in reason for reason in blocking_quality)
        )
        if can_repair:
            repaired_df, repaired_details = DQ.repair_isolated_outliers(
                df,
                provider=provider,
                interval=args.interval,
                asset_class=asset_spec.assetClass,
            )
            if repaired_details and len(repaired_df) < len(df):
                repaired_details_total.extend(repaired_details)
                df = repaired_df
                dq = DQ.report_with_repair(
                    DQ.analyze(df, args.interval, asset_spec.assetClass, provider=provider),
                    repaired_details_total,
                )
                blocking_quality = DQ.blocking_reasons(dq, asset_spec.assetClass)
        if blocking_quality:
            for d in dq.outlier_details[:5]:
                print(
                    f"__FINNY_OUTLIER__: ts={d.timestamp} prev_close={d.previous_close} "
                    f"close={d.current_close} log_return={d.log_return} z={d.z_score:.2f} provider={provider}",
                    file=sys.stderr,
                )
            raise SystemExit(_quality_failure(
                "Data quality failed after resample",
                blocking_quality,
                dq,
                provider=provider,
                symbol=str(symbol),
                interval=str(args.interval),
                raw_rows=raw_rows,
                post_rows=int(len(df)),
            ))

    ba = from_dataframe(df, symbol=symbol, atr_period=14)
    snap = MarketSnapshot({symbol: ba})

    # Pre-compute regime labels so strategies can read bar["vol_regime"] and
    # bar["trend_regime"] at decision time. Uses only settled data (lookback
    # windows on prior closes) — no lookahead.
    _vol_labels = classify_bars(ba.close, lookback=30)
    _trend_labels = classify_trend(ba.close, lookback=50)
    snap.attach_regime_labels(symbol, _vol_labels, _trend_labels)

    seed = args.seed if args.seed else derive_seed(cfg, str(df["timestamp"].iloc[0]),
                                                   str(df["timestamp"].iloc[-1]),
                                                   args.interval)

    broker = _build_broker(snap, cfg, args.interval, args.mode, asset_spec)
    params = cfg.get("params", None)
    strategy_path = Path(args.strategy)
    if args.mode == "v2":
        result = _run_shapec_strict_worker(broker, snap, strategy_path, symbol, params)
    else:
        strat, shape = _run_strategy(broker, snap,
                                     strategy_path, Path(args.config),
                                     symbol, params)
        if shape == "shapec":
            def shapec_callback():
                strat.on_bar(symbol, snap.decision_safe_bar(symbol))
                return {}
            result = run_loop(broker, snap, shapec_callback)
        else:
            result = run_loop(broker, snap, lambda: strat.on_bar())
    equity = result.equity_curve
    exposure_hist = result.gross_exposure

    wf = None
    if args.wf_folds and args.wf_folds >= 2:
        def fold_runner(start_idx: int, end_idx: int, eval_start_idx: int, fold_params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
            if end_idx - start_idx < 2:
                return {"sharpe": 0.0, "total_return": 0.0, "returns": np.zeros(0)}
            fold_df = df.iloc[start_idx:end_idx].reset_index(drop=True)
            fold_ba = from_dataframe(fold_df, symbol=symbol, atr_period=14)
            fold_snap = MarketSnapshot({symbol: fold_ba})
            fold_snap.attach_regime_labels(
                symbol,
                classify_bars(fold_ba.close, lookback=30),
                classify_trend(fold_ba.close, lookback=50),
            )
            fold_cfg = json.loads(json.dumps(cfg))
            if fold_params is not None:
                fold_cfg["params"] = fold_params
            fold_broker = _build_broker(fold_snap, fold_cfg, args.interval, args.mode, asset_spec)
            if args.mode == "v2":
                fold_result = _run_shapec_strict_worker(fold_broker, fold_snap, strategy_path, symbol, fold_cfg.get("params", None))
            else:
                fold_strat, fold_shape = _run_strategy(
                    fold_broker, fold_snap, strategy_path, Path(args.config), symbol, fold_cfg.get("params", None)
                )
                if fold_shape == "shapec":
                    def fold_cb():
                        fold_strat.on_bar(symbol, fold_snap.decision_safe_bar(symbol))
                        return {}
                    fold_result = run_loop(fold_broker, fold_snap, fold_cb)
                else:
                    fold_result = run_loop(fold_broker, fold_snap, lambda: fold_strat.on_bar())
            fold_equity = fold_result.equity_curve
            eval_offset = max(0, min(eval_start_idx - start_idx, fold_equity.size - 1))
            eval_equity = fold_equity[eval_offset:]
            fold_returns = M_returns.bar_returns(eval_equity)
            eval_start_ns = int(ts_ns[eval_start_idx])
            eval_trades = [t for t in fold_broker.book.trades if t.exit_ts_ns >= eval_start_ns]
            return {
                "sharpe": M_ratios.sharpe(fold_returns, bars_per_year),
                "total_return": M_returns.total_return(eval_equity),
                "returns": fold_returns,
                "trades": len(eval_trades),
                "bars": int(max(0, eval_equity.size - 1)),
                "max_drawdown": M_drawdown.max_drawdown(eval_equity),
                "min_equity": float(np.min(eval_equity)) if eval_equity.size else 0.0,
                "ruined": bool(eval_equity.size and np.min(eval_equity) <= 0.0),
            }
        wf = run_walk_forward(
            fold_runner,
            n_bars=int(ba.ts.shape[0]),
            ts_ns=ba.ts,
            n_folds=int(args.wf_folds),
            required_history_bars=required_history_bars,
            param_grid=param_grid,
        )

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
        monte_carlo=mc, walk_forward=wf, regimes=regimes, data_quality=dq,
        execution_config=_execution_config(cfg, args.mode, asset_spec),
        run_metadata={
            "strategy_hash": _sha256_bytes(strategy_path.read_bytes()),
            "config_hash": _sha256_bytes(json.dumps(cfg, sort_keys=True, separators=(",", ":")).encode("utf-8")),
            "data_hash": _data_hash(df),
            "seed": int(seed),
            "engine_mode": args.mode,
            "worker_protocol": "jsonl_intents_v1" if args.mode == "v2" else "legacy_unsafe",
            "asset_spec": asset_spec.to_dict(),
            "data_provider": provider,
            "fetch_symbol": str(symbol),
            "fetch_interval": str(args.interval),
            "raw_rows": raw_rows,
            "post_resample_rows": int(len(df)),
            "data_quality_blocking_reasons": blocking_quality,
        },
    )
    emit.write_artifacts(Path(args.out), results, equity, ba.ts, result.diagnostics, broker=broker)

    def _stdout_metric(value: Any) -> Any:
        return "nan" if value is None else value

    # Legacy line-format stdout for the existing TS parser fallback path.
    print(f"total_return: {results.total_return}")
    print(f"max_drawdown: {results.max_drawdown}")
    print(f"ann_vol: {results.ann_vol}")
    print(f"ann_sharpe: {results.ann_sharpe}")
    print(f"ending_equity: {results.ending_equity}")
    print(f"total_trades: {results.total_trades}")
    print(f"win_rate: {results.win_rate}")
    print(f"profit_factor: {_stdout_metric(results.profit_factor)}")
    print(f"schema_version: {results.schema_version}")


if __name__ == "__main__":
    main()
