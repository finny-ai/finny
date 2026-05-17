"""Execution realism: next-bar fills, limit through-trade, partial+TTL,
stop gap-adverse, short PnL, intra-bar liquidation."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np

from engine_v2.core.arrays import BarArrays, MarketSnapshot
from engine_v2.execution.costs import CostConfig
from engine_v2.execution.fills import FillConfig
from engine_v2.execution.orders import Order
from engine_v2.execution.slippage import SlippageConfig
from engine_v2.portfolio.account import Account
from engine_v2.runtime.broker import PortfolioBroker


def _bars(*ohlcv) -> BarArrays:
    o = np.array([row[0] for row in ohlcv], dtype=np.float64)
    h = np.array([row[1] for row in ohlcv], dtype=np.float64)
    lows = np.array([row[2] for row in ohlcv], dtype=np.float64)
    c = np.array([row[3] for row in ohlcv], dtype=np.float64)
    v = np.array([row[4] for row in ohlcv], dtype=np.float64)
    ts = np.arange(len(o), dtype=np.int64) * 60_000_000_000
    return BarArrays(symbol="X", ts=ts, open=o, high=h, low=lows, close=c, volume=v,
                     atr=np.full(len(o), 1.0))


def _setup(bars: BarArrays, mode: str = "v2", participation: float = 1.0):
    snap = MarketSnapshot({bars.symbol: bars})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode=mode, participation_pct=participation,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    return PortfolioBroker(snap, acct, costs, fcfg, interval="1m"), snap


def test_market_order_fills_at_next_bar_open_v2():
    ba = _bars((100, 101, 99, 100, 1000), (105, 106, 104, 105, 1000), (110, 111, 109, 110, 1000))
    broker, snap = _setup(ba, mode="v2")
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=10, order_type="market", tag="t"))
    # bar 0 process: order was submitted DURING bar 0; broker.process_bar(0) processes orders that exist NOW
    # But the strategy submits in on_bar AFTER process_bar(0). To mimic that, we test by calling process_bar(1) first.
    broker.process_bar(1)  # next bar fill at open of bar 1 = 105
    fills = broker.fills_log
    assert len(fills) == 1
    assert abs(fills[0].price - 105.0) < 1e-9


def test_market_order_fills_at_close_v1_compat():
    ba = _bars((100, 101, 99, 100, 1000), (105, 106, 104, 108, 1000))
    broker, snap = _setup(ba, mode="v1_compat")
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=10, order_type="market", tag="t"))
    broker.process_bar(1)
    assert abs(broker.fills_log[0].price - 108.0) < 1e-9


def test_limit_no_fill_when_not_traded_through():
    # Bar low=99, limit=98 → should NOT fill (low > limit, doesn't trade through)
    ba = _bars((100, 101, 99, 100, 1000), (100, 101, 99, 100, 1000))
    broker, snap = _setup(ba, mode="v2")
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=5, order_type="limit",
                              limit_price=98.0, tag="t"))
    broker.process_bar(1)
    assert len(broker.fills_log) == 0


def test_limit_fills_when_traded_through():
    # Bar low=97 < limit=98 → fills
    ba = _bars((100, 101, 99, 100, 1000), (100, 101, 97, 100, 1000))
    broker, snap = _setup(ba, mode="v2")
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=5, order_type="limit",
                              limit_price=98.0, tag="t"))
    broker.process_bar(1)
    assert len(broker.fills_log) == 1
    assert abs(broker.fills_log[0].price - 98.0) < 1e-9


def test_partial_fill_carries_until_ttl_expires():
    # Bar volume 100, qty 50, participation 0.10 → cap 10/bar
    ba = _bars((100, 101, 99, 100, 100), (100, 101, 99, 100, 100), (100, 101, 99, 100, 100))
    broker, snap = _setup(ba, mode="v2", participation=0.10)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=50, order_type="market",
                              ttl_bars=2, tag="t"))
    broker.process_bar(0)  # fills 10 (bar0)
    broker.process_bar(1)  # fills 10 (bar1) — but TTL=2 means bars_alive≤2
    broker.process_bar(2)  # bars_alive=3 → TTL expired, cancels remainder
    fills = broker.fills_log
    # We get 2 partial fills of 10 each, then cancellation
    total = sum(f.qty for f in fills)
    assert total == 20.0
    # Position carries the 20
    assert broker.get_position("X").qty == 20.0


def test_stop_gap_adverse_fill():
    # Buy stop at 105; next bar opens above stop (gap up) → fill at open, not stop
    ba = _bars((100, 101, 99, 100, 1000), (110, 112, 108, 111, 1000))
    broker, snap = _setup(ba, mode="v2")
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=5, order_type="stop",
                              stop_price=105.0, tag="t"))
    broker.process_bar(1)
    assert len(broker.fills_log) == 1
    # Gap-adverse: fill at max(open=110, stop=105) = 110
    assert abs(broker.fills_log[0].price - 110.0) < 1e-9


def test_short_pnl_realized():
    ba = _bars((100, 101, 99, 100, 1000), (100, 101, 99, 100, 1000), (80, 81, 79, 80, 1000))
    broker, snap = _setup(ba, mode="v2")
    broker.submit_order(Order(id="o1", symbol="X", side="sell", qty=10, order_type="market", tag="open_short"))
    broker.process_bar(1)  # fills at open=100
    broker.submit_order(Order(id="o2", symbol="X", side="buy", qty=10, order_type="market", tag="cover"))
    broker.process_bar(2)  # fills at open=80
    assert broker.get_position("X").qty == 0
    trades = broker.book.trades
    assert len(trades) == 1
    assert trades[0].side == "short"
    assert abs(trades[0].pnl - 200.0) < 1e-9   # (100-80)*10


def test_order_rejects_invalid_inputs():
    import pytest
    with pytest.raises(ValueError, match="qty"):
        Order(id="o1", symbol="X", side="buy", qty=0, order_type="market")
    with pytest.raises(ValueError, match="side"):
        Order(id="o1", symbol="X", side="long", qty=1, order_type="market")
    with pytest.raises(ValueError, match="order_type"):
        Order(id="o1", symbol="X", side="buy", qty=1, order_type="iceberg")
    with pytest.raises(ValueError, match="limit_price"):
        Order(id="o1", symbol="X", side="buy", qty=1, order_type="limit")
    with pytest.raises(ValueError, match="stop_price"):
        Order(id="o1", symbol="X", side="sell", qty=1, order_type="stop")


def test_fillconfig_rejects_bad_inputs():
    import pytest
    with pytest.raises(ValueError, match="participation"):
        FillConfig(mode="v2", participation_pct=1.5)
    with pytest.raises(ValueError, match="mode"):
        FillConfig(mode="weird")


def test_zero_volume_bar_does_not_fill_in_v2():
    ba = _bars((100, 101, 99, 100, 1000), (100, 101, 99, 100, 0))
    broker, snap = _setup(ba, mode="v2", participation=0.10)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=5, order_type="market", tag="t"))
    broker.process_bar(1)
    assert len(broker.fills_log) == 0


def test_liquidation_fill_returned_from_process_bar():
    ba = _bars(
        (100, 101, 99, 100, 1e9),
        (100, 100.5, 99.5, 100, 1e9),
        (100, 100, 90, 90, 1e9),
    )
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0,
                       maintenance_margin_pct=0.05)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=10_000,
                              order_type="market", tag="entry"))
    broker.process_bar(0)
    broker.process_bar(1)
    fills = broker.process_bar(2)
    assert any(f.tag == "LIQUIDATION" for f in fills), \
        "liquidation fill should appear in process_bar return"


def test_intra_bar_liquidation_long():
    # Account starts with 100k, opens 10000 ETH at $100 (notional $1m, 10x).
    # Liquidation triggers when low touches the calculated liq price.
    ba = _bars(
        (100, 101, 99, 100, 1e9),   # bar 0: entry
        (100, 100.5, 99.5, 100, 1e9),
        (100, 100, 90, 90, 1e9),    # bar 2: deep drawdown
    )
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0,
                       maintenance_margin_pct=0.05)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=10_000,
                              order_type="market", tag="entry"))
    broker.process_bar(0)
    broker.process_bar(1)
    broker.process_bar(2)
    # After deep drawdown, liquidation should have fired
    has_liq = any(t.liquidation for t in broker.book.trades) \
              or any(f.tag == "LIQUIDATION" for f in broker.fills_log)
    assert has_liq, "expected intra-bar liquidation"
    assert broker.get_position("X").qty == 0
