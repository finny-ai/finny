"""Machine-enforced risk contract for strict engine runs."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class RiskContract:
    sizing_stop_distance_pct: Optional[float]
    protective_stop_mode: str
    drawdown_mode: str
    drawdown_limit_pct: Optional[float]
    max_positions: Optional[int]

    @classmethod
    def legacy(cls) -> "RiskContract":
        return cls(
            sizing_stop_distance_pct=None,
            protective_stop_mode="none",
            drawdown_mode="evaluation_only",
            drawdown_limit_pct=None,
            max_positions=None,
        )

    @classmethod
    # @codescene(disable-all) Risk parsing is deliberately fail-closed in one schema boundary.
    def from_config(cls, config: Dict[str, Any]) -> "RiskContract":
        raw = config.get("risk_contract")
        if raw is None:
            return cls.legacy()
        if not _is_dict(raw):
            raise ValueError("risk_contract must be an object")

        protective = raw.get("protective_stop")
        drawdown = raw.get("drawdown")
        if not _is_dict(protective):
            raise ValueError("risk_contract.protective_stop must be an object")
        if not _is_dict(drawdown):
            raise ValueError("risk_contract.drawdown must be an object")

        sizing = _bounded_positive_pct(
            raw.get("sizing_stop_distance_pct"),
            "risk_contract.sizing_stop_distance_pct",
        )
        limit = _bounded_positive_pct(
            drawdown.get("limit_pct"),
            "risk_contract.drawdown.limit_pct",
        )
        stop_mode = str(protective.get("mode", ""))
        if stop_mode not in {"none", "strategy_next_open", "engine_stop"}:
            raise ValueError("risk_contract.protective_stop.mode is invalid")
        if stop_mode == "engine_stop":
            raise ValueError(
                "risk_contract.protective_stop.mode=engine_stop is unsupported: "
                "no contract-bound engine stop producer exists"
            )

        drawdown_mode = str(drawdown.get("mode", ""))
        if drawdown_mode not in {"evaluation_only", "halt_and_flatten_next_open"}:
            raise ValueError("risk_contract.drawdown.mode is invalid")

        max_positions_raw = raw.get("max_positions")
        if not _is_positive_int(max_positions_raw):
            raise ValueError("risk_contract.max_positions must be a positive integer")

        return cls(
            sizing_stop_distance_pct=sizing,
            protective_stop_mode=stop_mode,
            drawdown_mode=drawdown_mode,
            drawdown_limit_pct=limit,
            max_positions=max_positions_raw,
        )

    @property
    def enforces_drawdown(self) -> bool:
        return self.drawdown_mode == "halt_and_flatten_next_open"

    @property
    def is_legacy(self) -> bool:
        return (
            self.sizing_stop_distance_pct is None
            or self.drawdown_limit_pct is None
            or self.max_positions is None
        )

    @property
    def risk_budget_pct_per_position(self) -> Optional[float]:
        """Maximum stop-distance loss allocated to one position slot.

        Schema v4 deliberately carries a portfolio drawdown limit, a declared
        sizing stop distance, and a maximum number of positions.  Splitting the
        drawdown budget evenly across those slots gives the engine a
        deterministic upper bound without inventing another unrecorded risk
        parameter.  Gap risk and costs can still make realized loss larger;
        this is a sizing boundary, not a loss guarantee.
        """
        if self.drawdown_limit_pct is None or self.max_positions is None:
            return None
        return self.drawdown_limit_pct / float(self.max_positions)

    def stop_distance_for_price(self, price: float) -> Optional[float]:
        if self.sizing_stop_distance_pct is None:
            return None
        px = float(price)
        if not math.isfinite(px) or px <= 0:
            return None
        return px * self.sizing_stop_distance_pct / 100.0

    def max_position_qty(
        self,
        *,
        equity: float,
        price: float,
        multiplier: float = 1.0,
    ) -> Optional[float]:
        """Derive the maximum absolute position from the schema-v4 contract.

        At the declared stop distance, each of ``max_positions`` simultaneous
        positions consumes at most its equal share of the drawdown limit:

            qty = (equity * drawdown_limit / max_positions) /
                  (stop_distance_in_price_units * multiplier)

        Legacy/v3 contracts return ``None`` and therefore remain research-only
        rather than receiving an invented sizing policy.
        """
        stop_distance = self.stop_distance_for_price(price)
        if stop_distance is None:
            return None
        budget_pct = self.risk_budget_pct_per_position
        if budget_pct is None:
            return None
        capital = float(equity)
        if not _is_positive_number(capital):
            return None
        mult = float(multiplier)
        if not _is_positive_number(mult):
            return None
        risk_budget = capital * budget_pct / 100.0
        return risk_budget / (stop_distance * mult)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sizing_stop_distance_pct": self.sizing_stop_distance_pct,
            "protective_stop": {"mode": self.protective_stop_mode},
            "drawdown": {
                "mode": self.drawdown_mode,
                "limit_pct": self.drawdown_limit_pct,
            },
            "max_positions": self.max_positions,
        }



def _is_positive_number(value: float) -> bool:
    if not math.isfinite(value):
        return False
    return value > 0


def _is_dict(value: Any) -> bool:
    return isinstance(value, dict)


def _is_positive_int(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if not isinstance(value, int):
        return False
    return value > 0


def _bounded_positive_pct(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    parsed = float(value)
    if not 0.0 < parsed <= 100.0:
        raise ValueError(f"{field} must be > 0 and <= 100")
    return parsed
