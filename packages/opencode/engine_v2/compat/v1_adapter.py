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

# v1 dataclasses (Broker, MarketData, Order, Position) live in strategy.py at
# the repo root. They are imported lazily inside make_v1_compat() so that
# loading this module does not crash when the cwd's strategy.py is a Shape-C
# strategy that lacks those classes.

_v1_classes = None


def _load_v1_classes():
    global _v1_classes
    if _v1_classes is not None:
        return _v1_classes
    import sys as _sys
    from pathlib import Path as _Path
    _sys.path.insert(0, str(_Path(__file__).resolve().parents[2]))
    from strategy import (  # noqa: E402
        Broker as V1Broker,
        MarketData as V1MarketData,
        Order as V1Order,
        Position as V1Position,
    )
    _v1_classes = (V1Broker, V1MarketData, V1Order, V1Position)
    return _v1_classes


def make_v1_compat(snapshot: MarketSnapshot, broker: PortfolioBroker, symbol: str):
    V1Broker, V1MarketData, V1Order, V1Position = _load_v1_classes()

    class V1BrokerAdapter(V1Broker):
        def __init__(self, broker_: PortfolioBroker, symbol_: str):
            self.broker = broker_
            self.symbol = symbol_

        def get_equity(self) -> float:
            return float(self.broker.get_equity())

        def get_position(self, sym: str) -> Optional[V1Position]:
            if sym != self.symbol:
                return None
            p = self.broker.get_position(sym)
            return V1Position(
                symbol=p.symbol,
                qty=float(p.qty),
                avg_price=float(p.avg_price),
                unrealized_pnl=float(p.unrealized_pnl(self.broker.latest_price(sym))),
            )

        def list_open_orders(self, sym: str) -> List[V1Order]:
            out: List[V1Order] = []
            for o in self.broker.list_open_orders(sym):
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
                ttl_bars=None,
                tag=order.tag,
            )
            return self.broker.submit_order(v2)

        def cancel_order(self, order_id: str) -> None:
            self.broker.cancel_order(order_id)

        def latest_price(self, sym: str) -> float:
            return float(self.broker.latest_price(sym))

    class V1MarketAdapter(V1MarketData):
        def __init__(self, snapshot_: MarketSnapshot, symbol_: str):
            self.snapshot = snapshot_
            self.symbol = symbol_

        def candles(self, sym: str, timeframe: str, limit: int) -> pd.DataFrame:
            if sym != self.symbol:
                raise ValueError(f"symbol mismatch: {sym} != {self.symbol}")
            return self.snapshot.history(sym, limit)

    return V1BrokerAdapter(broker, symbol), V1MarketAdapter(snapshot, symbol)
