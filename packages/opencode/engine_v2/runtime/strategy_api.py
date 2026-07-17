"""v2 Strategy ABC. v1 strategies plug in via engine_v2.compat.v1_adapter."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict

if TYPE_CHECKING:
    from .broker import PortfolioBroker
    from ..core.arrays import MarketSnapshot


class Strategy:
    """Subclass + implement on_bar(). Submit orders via self.broker."""

    def __init__(self, broker: "PortfolioBroker", market: "MarketSnapshot", config: Dict[str, Any]):
        self.broker = broker
        self.market = market
        self.cfg = config

    def on_bar(self) -> Dict[str, Any]:
        raise NotImplementedError
