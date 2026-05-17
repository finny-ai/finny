"""Order types. All orders are queued at submission and processed at the
following bar (next-bar fill semantics). Limit fills require the bar to trade
through the limit; stops trigger when high/low cross the stop, fill is
gap-adverse."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional


def _finite(x: Optional[float]) -> bool:
    return x is not None and math.isfinite(float(x))


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
        if not math.isfinite(float(self.qty)) or self.qty <= 0:
            raise ValueError(f"order {self.id}: qty must be finite and > 0, got {self.qty}")
        if self.side not in {"buy", "sell"}:
            raise ValueError(f"order {self.id}: invalid side {self.side!r}")
        if self.order_type not in {"market", "limit", "stop", "stop_limit", "trailing_stop"}:
            raise ValueError(f"order {self.id}: invalid order_type {self.order_type!r}")
        if self.order_type in ("limit", "stop_limit"):
            if not _finite(self.limit_price):
                raise ValueError(f"order {self.id}: finite limit_price required for {self.order_type}")
        if self.order_type in ("stop", "stop_limit"):
            if not _finite(self.stop_price):
                raise ValueError(f"order {self.id}: finite stop_price required for {self.order_type}")
        if self.order_type == "trailing_stop":
            if not _finite(self.trail_amount) or float(self.trail_amount or 0) <= 0:
                raise ValueError(f"order {self.id}: finite trail_amount > 0 required for trailing_stop")
        if self.ttl_bars is not None and self.ttl_bars <= 0:
            raise ValueError(f"order {self.id}: ttl_bars must be > 0 if set")
        if self.qty_remaining == 0.0:
            self.qty_remaining = float(self.qty)
