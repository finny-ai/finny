"""Backtest harness for btc_liq_funding_news_v1.

Usage:
  python backtest.py --csv path/to/btc_1m.csv

CSV format (required columns):
  timestamp, open, high, low, close, volume

Notes:
- Perp funding + liquidations + news are not generally present in OHLCV. This harness:
  * uses wick/volume dislocation as the primary "liquidation" proxy
  * allows optional synthetic funding series (constant or derived)
  * does not model order book depth; limit fill is simplistic: if limit >= low, fill.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from strategy import BtcLiqFundingSentimentStrategy, Broker, MarketData, Order, Position


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
        # Only supports long entries and long exits for this strategy.
        if side == "buy":
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
    def __init__(
        self, df: pd.DataFrame, symbol: str, funding_rate: Optional[float] = -0.0006
    ):
        self.df = df
        self.symbol = symbol
        self._i = 0
        self._funding_rate = funding_rate

    def set_index(self, i: int) -> None:
        self._i = i

    def candles(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        if symbol != self.symbol:
            raise ValueError("symbol mismatch")
        start = max(0, self._i - limit + 1)
        return self.df.iloc[start : self._i + 1].copy()

    def funding_rate(self, symbol: str) -> Optional[float]:
        return self._funding_rate

    def liquidation_notional_1m(self, symbol: str) -> Optional[float]:
        # Not available in OHLCV backtest.
        return None

    def recent_headlines(self, lookback_minutes: int) -> List[str]:
        # No news in backtest by default.
        return []


def perf_stats(equity: pd.Series) -> Dict[str, float]:
    ret = equity.pct_change().fillna(0.0)
    total = float(equity.iloc[-1] / equity.iloc[0] - 1.0)
    dd = (equity / equity.cummax() - 1.0).min()
    vol = float(ret.std(ddof=0) * math.sqrt(60 * 24 * 365))  # annualized from 1m bars
    sharpe = float((ret.mean() / (ret.std(ddof=0) + 1e-12)) * math.sqrt(60 * 24 * 365))
    return {
        "total_return": total,
        "max_drawdown": float(dd),
        "ann_vol": vol,
        "ann_sharpe": sharpe,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="Path to OHLCV CSV")
    ap.add_argument("--config", default="config.json")
    ap.add_argument(
        "--funding",
        type=float,
        default=-0.0006,
        help="Constant funding rate used by backtest",
    )
    args = ap.parse_args()

    cfg = json.load(open(args.config, "r", encoding="utf-8"))
    symbol = cfg["symbol"]

    df = pd.read_csv(args.csv)
    # Normalize columns
    df.columns = [c.strip().lower() for c in df.columns]
    required = {"timestamp", "open", "high", "low", "close", "volume"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing columns: {missing}")

    df["timestamp"] = df["timestamp"].apply(parse_ts)
    df = df.sort_values("timestamp").reset_index(drop=True)
    df = df.rename(columns={"timestamp": "ts"})
    df = df.set_index("ts")
    df = df[["open", "high", "low", "close", "volume"]].astype(float)

    broker = PaperBroker(
        symbol=symbol,
        starting_equity=float(cfg["risk"].get("starting_equity_usd", 100.0)),
        maker_fee_bps=float(cfg["execution"].get("maker_fee_bps", 2.0)),
        taker_fee_bps=float(cfg["execution"].get("taker_fee_bps", 7.0)),
        slippage_bps=float(cfg["execution"].get("slippage_bps", 1.0)),
    )
    market = BacktestMarket(
        df=df.reset_index(), symbol=symbol, funding_rate=args.funding
    )
    strat = BtcLiqFundingSentimentStrategy(
        config_path=args.config, broker=broker, market=market
    )

    equity_curve: List[float] = []
    diag_rows: List[Dict[str, Any]] = []

    dfr = df.reset_index()
    for i in range(len(dfr)):
        market.set_index(i)
        row = dfr.iloc[i]
        ts = pd.Timestamp(row.ts).tz_convert("UTC")
        fills = broker.process_bar(ts, row.open, row.high, row.low, row.close)
        diag = strat.on_bar()
        diag["equity"] = broker.get_equity()
        diag["pos_qty"] = (
            broker.get_position(symbol).qty if broker.get_position(symbol) else 0.0
        )
        diag["fills"] = len(fills)
        equity_curve.append(broker.get_equity())
        diag_rows.append(diag)

    eq = pd.Series(equity_curve, index=df.index)
    stats = perf_stats(eq)
    print("=== Backtest Results ===")
    for k, v in stats.items():
        print(f"{k}: {v:.4f}")
    print(f"ending_equity: {float(eq.iloc[-1]):.2f}")

    out = pd.DataFrame(diag_rows)
    out.to_csv("backtest_diagnostics.csv", index=False)
    eq.to_csv("equity_curve.csv", header=["equity"])
    print("Wrote backtest_diagnostics.csv, equity_curve.csv")


if __name__ == "__main__":
    main()
