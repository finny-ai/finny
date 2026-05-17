"""Cash / margin / equity. Shared across all symbols (one book per account)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class Account:
    starting_cash: float
    cash: float
    margin_used: float = 0.0
    max_leverage: float = 1.0  # 1.0 = spot, no leverage
    maintenance_margin_pct: float = 0.05  # fraction of notional at which liq triggers
    last_prices: Dict[str, float] = field(default_factory=dict)

    @classmethod
    def new(cls, starting_cash: float, max_leverage: float = 1.0,
            maintenance_margin_pct: float = 0.05) -> "Account":
        return cls(
            starting_cash=float(starting_cash),
            cash=float(starting_cash),
            max_leverage=float(max_leverage),
            maintenance_margin_pct=float(maintenance_margin_pct),
        )

    def apply_realized(self, realized: float) -> None:
        self.cash += float(realized)

    def apply_fee(self, fee: float) -> None:
        self.cash -= float(fee)

    def apply_funding(self, amount: float) -> None:
        self.cash -= float(amount)

    def mark_prices(self, prices: Dict[str, float]) -> None:
        for k, v in prices.items():
            self.last_prices[k] = float(v)

    def equity(self, positions: Dict[str, "Position"]) -> float:  # type: ignore[name-defined]
        unrealized = 0.0
        for sym, pos in positions.items():
            if pos.qty == 0:
                continue
            px = self.last_prices.get(sym, pos.avg_price)
            unrealized += pos.qty * (px - pos.avg_price)
        return self.cash + unrealized

    def gross_notional(self, positions: Dict[str, "Position"]) -> float:  # type: ignore[name-defined]
        n = 0.0
        for sym, pos in positions.items():
            if pos.qty == 0:
                continue
            px = self.last_prices.get(sym, pos.avg_price)
            n += abs(pos.qty) * px
        return n

    def free_margin(self, positions: Dict[str, "Position"]) -> float:  # type: ignore[name-defined]
        return self.equity(positions) * self.max_leverage - self.gross_notional(positions)

    def can_open(self, notional: float, positions: Dict[str, "Position"]) -> bool:  # type: ignore[name-defined]
        return self.free_margin(positions) >= notional - 1e-9
