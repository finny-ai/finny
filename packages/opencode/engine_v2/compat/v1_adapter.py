"""Bind a v1 strategy (strategy.py:EthTrendBreakoutStrategy and similar) to
the v2 PortfolioBroker. v1 calls (`Broker.submit_order(Order)`, `get_position`,
`get_equity`, `latest_price`, `list_open_orders`, `cancel_order`) all route to
the underlying engine_v2 PortfolioBroker, with order translation between the
v1 Order dataclass and the v2 Order dataclass.

v1's `MarketData.candles(symbol, tf, limit)` returns a pandas frame of the
last `limit` bars up to the current cursor — we serve that from MarketSnapshot.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

import pandas as pd

from ..core.arrays import MarketSnapshot
from ..execution.orders import Order as V2Order
from ..runtime.broker import PortfolioBroker

# Import v1 dataclasses (Position/Order live in strategy.py at repo root).
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from strategy import (  # noqa: E402  (sys.path tweak)
    Broker as V1Broker,
    MarketData as V1MarketData,
    Order as V1Order,
    Position as V1Position,
)


class V1BrokerAdapter(V1Broker):
    def __init__(self, broker: PortfolioBroker, symbol: str):
        self.broker = broker
        self.symbol = symbol

    def get_equity(self) -> float:
        return float(self.broker.get_equity())

    def get_position(self, symbol: str) -> Optional[V1Position]:
        if symbol != self.symbol:
            return None
        p = self.broker.get_position(symbol)
        return V1Position(
            symbol=p.symbol,
            qty=float(p.qty),
            avg_price=float(p.avg_price),
            unrealized_pnl=float(p.unrealized_pnl(self.broker.latest_price(symbol))),
        )

    def list_open_orders(self, symbol: str) -> List[V1Order]:
        out: List[V1Order] = []
        for o in self.broker.list_open_orders(symbol):
            out.append(V1Order(
                id=o.id, side=o.side, qty=o.qty_remaining,
                order_type=o.order_type, limit_price=o.limit_price,
                tag=o.tag,
            ))
        return out

    def submit_order(self, order: V1Order) -> str:
        oid = order.id or uuid.uuid4().hex
        v2 = V2Order(
            id=oid, symbol=self.symbol, side=order.side, qty=float(order.qty),
            order_type=order.order_type, limit_price=order.limit_price,
            ttl_bars=None,  # v1 used ttl_minutes which only mattered for limits
            tag=order.tag,
        )
        return self.broker.submit_order(v2)

    def cancel_order(self, order_id: str) -> None:
        self.broker.cancel_order(order_id)

    def latest_price(self, symbol: str) -> float:
        return float(self.broker.latest_price(symbol))


class V1MarketAdapter(V1MarketData):
    def __init__(self, snapshot: MarketSnapshot, symbol: str):
        self.snapshot = snapshot
        self.symbol = symbol

    def candles(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        if symbol != self.symbol:
            raise ValueError(f"symbol mismatch: {symbol} != {self.symbol}")
        return self.snapshot.history(symbol, limit)


def make_v1_compat(snapshot: MarketSnapshot, broker: PortfolioBroker, symbol: str):
    return V1BrokerAdapter(broker, symbol), V1MarketAdapter(snapshot, symbol)
