"""Order types. All orders are queued at submission and processed at the
following bar (next-bar fill semantics). Limit fills require the bar to trade
through the limit; stops trigger when high/low cross the stop, fill is
gap-adverse."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Order:
    id: str
    symbol: str
    side: str             # "buy" | "sell"
    qty: float
    order_type: str       # "market" | "limit" | "stop" | "stop_limit" | "trailing_stop"
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    trail_amount: Optional[float] = None   # distance for trailing stop
    submitted_ts_ns: int = 0
    ttl_bars: Optional[int] = None
    bars_alive: int = 0
    qty_remaining: float = 0.0             # set at submission
    tag: str = ""
    stop_distance_hint: Optional[float] = None   # for R-multiple bookkeeping
    high_water: float = 0.0                 # for trailing stop tracking

    def __post_init__(self) -> None:
        if self.qty_remaining == 0.0:
            self.qty_remaining = float(self.qty)
