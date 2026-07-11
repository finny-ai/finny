"""Schema-v4 risk contract parsing and engine enforcement."""

from __future__ import annotations

import numpy as np
import pytest

from engine_v2.core.arrays import BarArrays, MarketSnapshot
from engine_v2.execution.costs import CostConfig
from engine_v2.execution.fills import FillConfig
from engine_v2.execution.orders import Order
from engine_v2.execution.slippage import SlippageConfig
from engine_v2.execution.spread import SpreadConfig
from engine_v2.portfolio.account import Account
from engine_v2.runtime.broker import PortfolioBroker
from engine_v2.runtime.risk import RiskContract


def _bars(symbol: str, *ohlcv) -> BarArrays:
    return BarArrays(
        symbol=symbol,
        ts=np.arange(len(ohlcv), dtype=np.int64) * 60_000_000_000,
        open=np.array([row[0] for row in ohlcv], dtype=np.float64),
        high=np.array([row[1] for row in ohlcv], dtype=np.float64),
        low=np.array([row[2] for row in ohlcv], dtype=np.float64),
        close=np.array([row[3] for row in ohlcv], dtype=np.float64),
        volume=np.array([row[4] for row in ohlcv], dtype=np.float64),
        atr=np.full(len(ohlcv), 1.0),
    )


def _contract(
    *,
    drawdown_mode="halt_and_flatten_next_open",
    limit=10.0,
    max_positions=1,
    sizing_stop_distance_pct=2.0,
):
    return RiskContract.from_config({
        "risk_contract": {
            "sizing_stop_distance_pct": sizing_stop_distance_pct,
            "protective_stop": {"mode": "strategy_next_open"},
            "drawdown": {"mode": drawdown_mode, "limit_pct": limit},
            "max_positions": max_positions,
        }
    })


def _broker(
    market: MarketSnapshot,
    contract: RiskContract,
    *,
    participation=1.0,
    max_leverage=1.0,
) -> PortfolioBroker:
    return PortfolioBroker(
        market,
        Account.new(
            starting_cash=100_000.0,
            max_leverage=max_leverage,
            maintenance_margin_pct=0.0,
        ),
        CostConfig(maker_fee_bps=0.0, taker_fee_bps=5.0),
        FillConfig(
            mode="v2",
            participation_pct=participation,
            slippage=SlippageConfig(base_bps=10.0, k_atr=0.0, k_vol=0.0),
            spread=SpreadConfig(enabled=False, min_bps=5.0),
        ),
        interval="1m",
        risk_contract=contract,
    )


def test_contract_rejects_unsupported_engine_stop():
    with pytest.raises(ValueError, match="engine_stop is unsupported"):
        RiskContract.from_config({
            "risk_contract": {
                "sizing_stop_distance_pct": 2,
                "protective_stop": {"mode": "engine_stop"},
                "drawdown": {"mode": "evaluation_only", "limit_pct": 10},
                "max_positions": 1,
            }
        })


def test_schema_v4_stop_distance_derives_and_constrains_position_sizing():
    bars = _bars(
        "X",
        (100, 101, 99, 100, 100_000),
        (100, 101, 99, 100, 100_000),
    )
    market = MarketSnapshot({"X": bars})
    market.set_index(0)
    contract = _contract(limit=10.0, sizing_stop_distance_pct=20.0)
    broker = _broker(market, contract, max_leverage=10.0)

    order = Order(id="oversized", symbol="X", side="buy", qty=1_000, order_type="market")
    assert broker.submit_order(order) == "oversized"

    # Risk budget is 10% of $100k; a 20% stop at $100 risks $20/unit.
    # The engine therefore caps the position at 500 units even though margin
    # would allow the original 1,000-unit request.
    assert order.qty == pytest.approx(500.0)
    assert order.qty_remaining == pytest.approx(500.0)
    assert order.stop_distance_hint == pytest.approx(20.0)
    sizing = broker.diagnostics()["risk_sizing_events"][-1]
    assert sizing["status"] == "constrained"
    assert sizing["requested_qty"] == pytest.approx(1_000.0)
    assert sizing["accepted_qty"] == pytest.approx(500.0)
    assert sizing["risk_budget_pct_per_position"] == pytest.approx(10.0)

    market.set_index(1)
    fills = broker.process_open(1)
    assert sum(fill.qty for fill in fills) == pytest.approx(500.0)
    assert broker.get_position("X").stop_distance == pytest.approx(20.0)

    # A reduction is never blocked or resized by the entry sizing boundary.
    exit_order = Order(id="exit", symbol="X", side="sell", qty=500, order_type="market")
    assert broker.submit_order(exit_order) == "exit"
    assert exit_order.qty == pytest.approx(500.0)


def test_legacy_contract_does_not_invent_a_sizing_policy():
    legacy = RiskContract.legacy()
    assert legacy.is_legacy is True
    assert legacy.risk_budget_pct_per_position is None
    assert legacy.stop_distance_for_price(100.0) is None
    assert legacy.max_position_qty(equity=100_000, price=100) is None


def test_max_positions_rejects_projected_second_symbol():
    x = _bars("X", (100, 101, 99, 100, 1_000), (100, 101, 99, 100, 1_000))
    y = _bars("Y", (50, 51, 49, 50, 1_000), (50, 51, 49, 50, 1_000))
    market = MarketSnapshot({"X": x, "Y": y})
    market.set_index(0)
    broker = _broker(market, _contract(max_positions=1))

    assert broker.submit_order(Order(id="x", symbol="X", side="buy", qty=10, order_type="market")) == "x"
    assert broker.submit_order(Order(id="y", symbol="Y", side="buy", qty=10, order_type="market")) == ""
    assert broker.rejections[-1]["reason"] == "max_positions"


def test_drawdown_halt_cancels_rejects_and_flattens_next_open_with_costs():
    bars = _bars(
        "X",
        (100, 101, 99, 100, 10_000),
        (100, 121, 99, 120, 10_000),
        (120, 121, 89, 90, 10_000),
        (80, 81, 79, 80, 10_000),
    )
    market = MarketSnapshot({"X": bars})
    broker = _broker(market, _contract(limit=10.0))

    market.set_index(0)
    broker.submit_order(Order(id="entry", symbol="X", side="buy", qty=900, order_type="market"))
    broker.process_bar(0)
    broker.submit_order(Order(
        id="stale", symbol="X", side="buy", qty=1, order_type="limit", limit_price=1.0,
    ))

    market.set_index(1)
    broker.process_bar(1)
    market.set_index(2)
    broker.process_bar(2)

    trigger = broker.drawdown_trigger
    assert trigger is not None
    assert trigger["bar_index"] == 2
    assert trigger["drawdown_pct"] >= 10.0
    assert trigger["canceled_pending_orders"] == 1
    assert broker.orders == []
    assert broker.halted is True

    rejected = broker.submit_order(Order(id="late", symbol="X", side="buy", qty=1, order_type="market"))
    assert rejected == ""
    assert broker.rejections[-1]["reason"] == "drawdown_halt"

    market.set_index(3)
    fills = broker.process_open(3)
    assert len(fills) == 1
    assert fills[0].tag == "DRAWDOWN_FLATTEN"
    assert fills[0].price < 80.0  # adverse sell-side slippage + spread
    assert fills[0].fee > 0.0
    assert broker.get_position("X").qty == 0.0
    assert trigger["flatten_execution_bar"] == 3
    assert trigger["flatten_status"] == "completed"
    assert trigger["flatten_fees"] == pytest.approx(fills[0].fee)


def test_drawdown_flatten_bypasses_low_participation_and_volume_but_keeps_costs():
    bars = _bars(
        "X",
        (100, 101, 99, 100, 1_000_000),
        (100, 121, 99, 120, 1),
        (120, 121, 89, 90, 1),
        (80, 81, 79, 80, 1),
    )
    market = MarketSnapshot({"X": bars})
    broker = _broker(market, _contract(limit=10.0), participation=0.001)

    # Submit after bar 0, so the entry at bar 1 can use bar 0's ample volume.
    market.set_index(0)
    broker.process_bar(0)
    broker.submit_order(Order(id="entry", symbol="X", side="buy", qty=900, order_type="market"))

    market.set_index(1)
    broker.process_bar(1)
    assert broker.get_position("X").qty == pytest.approx(900.0)

    market.set_index(2)
    broker.process_bar(2)
    assert broker.drawdown_trigger is not None
    assert broker.drawdown_trigger["flatten_status"] == "scheduled"

    # Ordinary participation would allow only 0.001 units against prior volume
    # of one.  The hard-risk flatten must close all 900 units at this one open.
    market.set_index(3)
    fills = broker.process_open(3)
    assert len(fills) == 1
    assert fills[0].qty == pytest.approx(900.0)
    assert fills[0].tag == "DRAWDOWN_FLATTEN"
    assert fills[0].price < 80.0  # adverse dynamic slippage plus spread
    assert fills[0].fee > 0.0
    assert broker.get_position("X").qty == 0.0
    assert broker.drawdown_trigger["flatten_status"] == "completed"
    assert broker.drawdown_trigger["remaining_symbols"] == []


def test_evaluation_only_records_no_halt():
    bars = _bars("X", (100, 101, 99, 100, 10_000), (100, 101, 49, 50, 10_000))
    market = MarketSnapshot({"X": bars})
    broker = _broker(market, _contract(drawdown_mode="evaluation_only", limit=1.0))
    market.set_index(0)
    broker.submit_order(Order(id="entry", symbol="X", side="buy", qty=900, order_type="market"))
    broker.process_bar(0)
    market.set_index(1)
    broker.process_bar(1)
    assert broker.drawdown_trigger is None
    assert broker.halted is False
