"""Shape-C broker adapter. Wraps PortfolioBroker with the simple
buy/sell/position/cash/equity/price API that Shape-C strategies expect.

Shape-C is the canonical strategy format for all new Finny algorithms.
Strategies receive this adapter as ``broker`` in their constructor and call
its methods from ``on_bar(symbol, bar)``.

Fill semantics: PortfolioBroker queues orders and fills on the NEXT bar.
A ``buy()`` followed by ``position()`` in the same ``on_bar`` returns 0.
This is by design — it prevents lookahead bias.
"""

from __future__ import annotations

import uuid
from typing import Optional

from ..core.arrays import MarketSnapshot
from ..execution.orders import Order
from ..runtime.broker import PortfolioBroker


class ShapeCBrokerAdapter:
    def __init__(self, broker: PortfolioBroker, market: MarketSnapshot, symbol: str):
        self._broker = broker
        self._market = market
        self._symbol = symbol

    def buy(self, symbol: str, qty: Optional[float] = None,
            notional: Optional[float] = None) -> None:
        px = self.price(symbol)
        if px <= 0:
            return
        if qty is None and notional is None:
            qty = self.cash() / px
        elif notional is not None:
            qty = notional / px
        qty = round(float(qty), 8)
        if qty <= 0:
            return
        self._broker.submit_order(Order(
            id=uuid.uuid4().hex, symbol=symbol, side="buy",
            qty=qty, order_type="market",
        ))

    def sell(self, symbol: str, qty: Optional[float] = None,
             notional: Optional[float] = None) -> None:
        if qty is None and notional is None:
            qty = abs(self.position(symbol))
        elif notional is not None:
            px = self.price(symbol)
            if px <= 0:
                return
            qty = notional / px
        qty = round(float(qty), 8)
        if qty <= 0:
            return
        self._broker.submit_order(Order(
            id=uuid.uuid4().hex, symbol=symbol, side="sell",
            qty=qty, order_type="market",
        ))

    def position(self, symbol: str) -> float:
        return float(self._broker.get_position(symbol).qty)

    def cash(self) -> float:
        return float(self._broker.account.cash)

    def equity(self) -> float:
        return float(self._broker.get_equity())

    def price(self, symbol: str) -> float:
        return float(self._broker.latest_price(symbol))
