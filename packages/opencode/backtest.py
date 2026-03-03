"""Backtest harness for eth_trend_breakout_v1.

Usage:
  python3 backtest.py --csv path/to/eth.csv --start-date YYYY-MM-DD --end-date YYYY-MM-DD --interval 15m --capital 10000

CSV format (required columns):
  timestamp, open, high, low, close, volume

Notes:
- This harness backtests the strategy on OHLCV candles.
- It does not model partial fills, order book depth, or latency.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple, cast

import numpy as np
import pandas as pd

from strategy import EthTrendBreakoutStrategy, Broker, MarketData, Order, Position


def parse_ts(x: Any) -> pd.Timestamp:
    # Accept unix seconds/ms or ISO
    if isinstance(x, (int, float)):
        # Heuristic: ms if big
        if x > 1e12:
            return pd.to_datetime(int(x), unit="ms", utc=True)
        return pd.to_datetime(int(x), unit="s", utc=True)
    return pd.to_datetime(x, utc=True)


@dataclass
class SimFill:
    side: str
    qty: float
    price: float
    fee_usd: float
    tag: str


class PaperBroker(Broker):
    def __init__(
        self,
        symbol: str,
        starting_equity: float,
        maker_fee_bps: float,
        taker_fee_bps: float,
        slippage_bps: float,
    ):
        self.symbol = symbol
        self.cash = float(starting_equity)
        self.equity = float(starting_equity)
        self.pos = Position(symbol=symbol, qty=0.0, avg_price=0.0)
        self.open_orders: Dict[str, Order] = {}
        self.maker_fee_bps = float(maker_fee_bps)
        self.taker_fee_bps = float(taker_fee_bps)
        self.slippage_bps = float(slippage_bps)
        self._last_price = 0.0

        # Trade stats (assumes single position per symbol; supports multiple fills)
        self._cash_before_trade: Optional[float] = None
        self._pos_qty_before_fill: float = 0.0
        self.trades: List[Dict[str, float]] = []  # {pnl}

    def mark_price(self, px: float) -> None:
        self._last_price = float(px)
        self._update_equity()

    def _fee(self, notional: float, is_maker: bool) -> float:
        bps = self.maker_fee_bps if is_maker else self.taker_fee_bps
        return abs(notional) * (bps / 10_000.0)

    def _update_equity(self) -> None:
        if self.pos.qty == 0:
            self.equity = self.cash
            return
        self.pos.unrealized_pnl = self.pos.qty * (self._last_price - self.pos.avg_price)
        self.equity = self.cash + self.pos.unrealized_pnl

    def get_equity(self) -> float:
        return float(self.equity)

    def get_position(self, symbol: str) -> Optional[Position]:
        if symbol != self.symbol:
            return None
        return self.pos

    def list_open_orders(self, symbol: str) -> List[Order]:
        if symbol != self.symbol:
            return []
        return list(self.open_orders.values())

    def submit_order(self, order: Order) -> str:
        self.open_orders[order.id] = order
        return order.id

    def cancel_order(self, order_id: str) -> None:
        self.open_orders.pop(order_id, None)

    def latest_price(self, symbol: str) -> float:
        return float(self._last_price)

    def _fill_market(self, side: str, qty: float, tag: str) -> SimFill:
        # Apply slippage
        px = self._last_price
        slip = px * (self.slippage_bps / 10_000.0)
        fill_px = px + slip if side == "buy" else px - slip
        notional = qty * fill_px
        fee = self._fee(notional, is_maker=False)
        self._apply_fill(side, qty, fill_px, fee)
        return SimFill(side=side, qty=qty, price=fill_px, fee_usd=fee, tag=tag)

    def _apply_fill(self, side: str, qty: float, price: float, fee: float) -> None:
        self._pos_qty_before_fill = float(self.pos.qty)

        # Only supports long entries and long exits for this strategy.
        if side == "buy":
            # Start-of-trade snapshot when going from flat -> long
            if self.pos.qty == 0 and qty > 0 and self._cash_before_trade is None:
                self._cash_before_trade = float(self.cash)

            new_qty = self.pos.qty + qty
            if self.pos.qty == 0:
                self.pos.avg_price = price
            else:
                self.pos.avg_price = (
                    self.pos.avg_price * self.pos.qty + price * qty
                ) / new_qty
            self.pos.qty = new_qty
            self.cash -= fee
        else:
            # sell
            sell_qty = min(qty, self.pos.qty)
            pnl = sell_qty * (price - self.pos.avg_price)
            self.pos.qty -= sell_qty
            if self.pos.qty == 0:
                self.pos.avg_price = 0.0
            self.cash += pnl
            self.cash -= fee
        self._update_equity()

        # End-of-trade snapshot when going long -> flat
        if (
            self._pos_qty_before_fill > 0
            and self.pos.qty == 0
            and self._cash_before_trade is not None
        ):
            trade_pnl = float(self.cash - self._cash_before_trade)
            self.trades.append({"pnl": trade_pnl})
            self._cash_before_trade = None

    def process_bar(
        self, ts: pd.Timestamp, o: float, h: float, l: float, c: float
    ) -> List[SimFill]:
        self.mark_price(float(c))
        fills: List[SimFill] = []
        to_cancel: List[str] = []
        for oid, order in list(self.open_orders.items()):
            # TTL
            if order.created_at and order.ttl_minutes is not None:
                created = pd.Timestamp(order.created_at).tz_convert("UTC")
                if ts >= created + pd.Timedelta(minutes=int(order.ttl_minutes)):
                    to_cancel.append(oid)
                    continue

            if order.order_type == "market":
                fills.append(
                    self._fill_market(order.side, float(order.qty), tag=order.tag)
                )
                to_cancel.append(oid)
                continue

            # limit
            limit_px = float(order.limit_price or 0.0)
            if order.side == "buy":
                if limit_px >= float(l):
                    notional = order.qty * limit_px
                    fee = self._fee(notional, is_maker=True)
                    self._apply_fill(
                        "buy", float(order.qty), float(limit_px), float(fee)
                    )
                    fills.append(
                        SimFill(
                            side="buy",
                            qty=float(order.qty),
                            price=float(limit_px),
                            fee_usd=float(fee),
                            tag=order.tag,
                        )
                    )
                    to_cancel.append(oid)
            else:
                if limit_px <= float(h):
                    notional = order.qty * limit_px
                    fee = self._fee(notional, is_maker=True)
                    self._apply_fill(
                        "sell", float(order.qty), float(limit_px), float(fee)
                    )
                    fills.append(
                        SimFill(
                            side="sell",
                            qty=float(order.qty),
                            price=float(limit_px),
                            fee_usd=float(fee),
                            tag=order.tag,
                        )
                    )
                    to_cancel.append(oid)

        for oid in to_cancel:
            self.open_orders.pop(oid, None)
        return fills


class BacktestMarket(MarketData):
    def __init__(self, df: pd.DataFrame, symbol: str):
        self.df = df
        self.symbol = symbol
        self._i = 0

    def set_index(self, i: int) -> None:
        self._i = i

    def candles(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        if symbol != self.symbol:
            raise ValueError("symbol mismatch")
        start = max(0, self._i - limit + 1)
        return self.df.iloc[start : self._i + 1].copy()

    # Extensions like funding/news can be added by implementing more methods.


def _interval_to_rule_and_bars_per_year(interval: str) -> Tuple[str, float]:
    s = interval.strip().lower()
    if s.endswith("min"):
        s = s[: -len("min")] + "m"
    if s.endswith("mins"):
        s = s[: -len("mins")] + "m"

    if s.endswith("m"):
        n = int(s[:-1])
        rule = f"{n}min"  # minutes
        bars_per_year = (60.0 / n) * 24.0 * 365.0
        return rule, bars_per_year
    if s.endswith("h"):
        n = int(s[:-1])
        rule = f"{n}H"
        bars_per_year = (24.0 / n) * 365.0
        return rule, bars_per_year
    if s.endswith("d"):
        n = int(s[:-1])
        rule = f"{n}D"
        bars_per_year = (1.0 / n) * 365.0
        return rule, bars_per_year

    raise ValueError(f"Unsupported interval: {interval}")


def perf_stats(equity: pd.Series, bars_per_year: float) -> Dict[str, float]:
    ret = equity.pct_change().fillna(0.0)
    total = float(equity.iloc[-1] / equity.iloc[0] - 1.0)
    dd = float((equity / equity.cummax() - 1.0).min())
    vol = float(ret.std(ddof=0) * math.sqrt(bars_per_year))
    sharpe = float((ret.mean() / (ret.std(ddof=0) + 1e-12)) * math.sqrt(bars_per_year))
    return {
        "total_return": total,
        "max_drawdown": dd,
        "ann_vol": vol,
        "ann_sharpe": sharpe,
    }


def trade_stats(trades: List[Dict[str, float]]) -> Dict[str, float]:
    if not trades:
        return {"total_trades": 0.0, "win_rate": 0.0, "profit_factor": 0.0}
    pnls = [float(t.get("pnl", 0.0)) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    win_rate = float(len(wins) / len(pnls))
    gross_profit = float(sum(wins))
    gross_loss = float(abs(sum(losses)))
    profit_factor = float(gross_profit / gross_loss) if gross_loss > 0 else float("inf")
    return {
        "total_trades": float(len(pnls)),
        "win_rate": win_rate,
        "profit_factor": profit_factor,
    }


def _parse_date_utc(s: str) -> pd.Timestamp:
    # YYYY-MM-DD
    return pd.to_datetime(s, utc=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="Path to OHLCV CSV")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--start-date", help="YYYY-MM-DD (UTC)")
    ap.add_argument("--end-date", help="YYYY-MM-DD (UTC)")
    ap.add_argument(
        "--interval",
        default=None,
        help="Resample interval: 1min,5min,15min,30min,1h,4h,1d (or 15m, etc.)",
    )
    ap.add_argument("--capital", type=float, default=None)
    args = ap.parse_args()

    cfg = json.load(open(args.config, "r", encoding="utf-8"))
    symbol = cfg["symbol"]

    df: pd.DataFrame = pd.read_csv(args.csv)
    # Normalize columns
    df.columns = [c.strip().lower() for c in df.columns]
    required = {"timestamp", "open", "high", "low", "close", "volume"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing columns: {missing}")

    df["timestamp"] = df["timestamp"].apply(parse_ts)
    df = df.sort_values("timestamp").reset_index(drop=True)
    df = df.rename(columns={"timestamp": "ts"})
    df = cast(pd.DataFrame, df.set_index("ts"))
    df = cast(
        pd.DataFrame, df[["open", "high", "low", "close", "volume"]].astype(float)
    )

    # Optional date filtering
    if args.start_date:
        start = _parse_date_utc(args.start_date)
        df = cast(pd.DataFrame, df[df.index >= start])
    if args.end_date:
        # inclusive end-date
        end = _parse_date_utc(args.end_date) + pd.Timedelta(days=1)
        df = cast(pd.DataFrame, df[df.index < end])

    if len(df) == 0:
        raise ValueError("No candles after applying date filters")

    # Optional resampling
    bars_per_year = 60.0 * 24.0 * 365.0
    if args.interval:
        rule, bars_per_year = _interval_to_rule_and_bars_per_year(args.interval)
        df = cast(
            pd.DataFrame,
            df.resample(rule, label="left", closed="left")
            .agg(
                {
                    "open": "first",
                    "high": "max",
                    "low": "min",
                    "close": "last",
                    "volume": "sum",
                }
            )
            .dropna(),
        )
    else:
        # If no interval provided, infer annualization from config timeframe when possible
        try:
            rule, bars_per_year = _interval_to_rule_and_bars_per_year(
                str(cfg.get("timeframe", "1min"))
            )
        except Exception:
            bars_per_year = 60.0 * 24.0 * 365.0

    if len(df) == 0:
        raise ValueError("No candles after resampling")

    # Capital override (also update config in-memory for risk checks)
    starting_equity = float(cfg["risk"].get("starting_equity_usd", 100.0))
    if args.capital is not None:
        starting_equity = float(args.capital)
        cfg.setdefault("risk", {})["starting_equity_usd"] = starting_equity

    broker = PaperBroker(
        symbol=symbol,
        starting_equity=float(starting_equity),
        maker_fee_bps=float(cfg["execution"].get("maker_fee_bps", 2.0)),
        taker_fee_bps=float(cfg["execution"].get("taker_fee_bps", 7.0)),
        slippage_bps=float(cfg["execution"].get("slippage_bps", 1.0)),
    )
    market = BacktestMarket(df=cast(pd.DataFrame, df.reset_index()), symbol=symbol)
    strat = EthTrendBreakoutStrategy(
        config_path=args.config, broker=broker, market=market
    )

    equity_curve: List[float] = []
    diag_rows: List[Dict[str, Any]] = []

    dfr = cast(pd.DataFrame, df.reset_index())
    for i in range(len(dfr)):
        market.set_index(i)
        row = dfr.iloc[i]
        ts = cast(pd.Timestamp, pd.to_datetime(row.ts, utc=True))
        fills = broker.process_bar(
            ts, float(row.open), float(row.high), float(row.low), float(row.close)
        )
        diag = strat.on_bar()
        diag["equity"] = broker.get_equity()
        pos = broker.get_position(symbol)
        diag["pos_qty"] = float(pos.qty) if pos is not None else 0.0
        diag["fills"] = len(fills)
        equity_curve.append(broker.get_equity())
        diag_rows.append(diag)

    eq = pd.Series(equity_curve, index=df.index)
    stats = perf_stats(eq, bars_per_year=bars_per_year)
    tstats = trade_stats(broker.trades)
    print("=== Backtest Results ===")
    merged: Dict[str, float] = {**stats, **tstats}
    for k, v in merged.items():
        if math.isfinite(float(v)):
            print(f"{k}: {float(v):.6f}")
        else:
            print(f"{k}: {v}")
    print(f"ending_equity: {float(eq.iloc[-1]):.2f}")

    out = pd.DataFrame(diag_rows)
    out.to_csv("backtest_diagnostics.csv", index=False)
    eq.to_csv("equity_curve.csv", header=["equity"])
    print("Wrote backtest_diagnostics.csv, equity_curve.csv")


if __name__ == "__main__":
    main()
