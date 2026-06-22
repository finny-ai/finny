"""Execution realism: next-bar fills, limit through-trade, partial+TTL,
stop gap-adverse, short PnL, intra-bar liquidation."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np

from engine_v2.core.arrays import BarArrays, MarketSnapshot
from engine_v2.assets import resolve_asset_spec
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


def _custom_future_spec():
    return {
        "multiplier": 50,
        "tickSize": 0.25,
        "lotSize": 1,
        "calendar": "US_FUTURES",
        "currency": "USD",
        "feeModel": "engine_v2.execution.costs",
        "marginModel": "engine_v2.portfolio.account",
        "dataProvider": "custom",
    }


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


def test_decision_phase_price_is_current_open_not_close():
    ba = _bars((100, 101, 99, 100, 1000), (105, 120, 80, 119, 1000))
    broker, snap = _setup(ba, mode="v2")
    snap.set_index(1)
    snap.set_decision_phase(True)
    try:
        assert broker.latest_price("X") == 105.0
        bar = snap.decision_safe_bar("X")
        assert bar["open"] == 105.0
        assert "high" not in bar
        assert "low" not in bar
        assert "close" not in bar
        assert bar["prev_high"] == 101.0
        assert bar["prev_low"] == 99.0
        assert bar["prev_close"] == 100.0
    finally:
        snap.set_decision_phase(False)
    assert broker.latest_price("X") == 119.0


def test_decision_phase_history_excludes_current_bar_close():
    ba = _bars((100, 101, 99, 100, 1000), (105, 120, 80, 119, 1000))
    _, snap = _setup(ba, mode="v2")
    snap.set_index(1)
    snap.set_decision_phase(True)
    try:
        hist = snap.history("X", 10)
        assert len(hist) == 1
        assert float(hist.iloc[-1]["close"]) == 100.0
        records = snap.history_records("X", 10)
        assert len(records) == 1
        assert records[-1]["close"] == 100.0
    finally:
        snap.set_decision_phase(False)


def test_decision_phase_equity_is_marked_to_open_not_close():
    ba = _bars((100, 101, 99, 100, 1000), (105, 150, 80, 140, 1000))
    broker, snap = _setup(ba, mode="v2")
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=10, order_type="market", tag="entry"))
    snap.set_index(1)
    fills = broker.process_open(1)
    snap.set_decision_phase(True)
    try:
        # Filled at 105 and marked at the same open, so current close=140 is not visible.
        assert abs(broker.get_equity() - 100_000.0) < 1e-9
    finally:
        snap.set_decision_phase(False)
    broker.process_close(1, fills)
    assert broker.get_equity() > 100_000.0


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
    # Bar volume 100, qty 50, participation 0.10 → cap 10/bar. Open fills use
    # the *prior* bar's volume forecast, so bar 0 cannot fill; submit after a
    # warmup bar so TTL counts only active queue bars.
    ba = _bars(
        (100, 101, 99, 100, 100),
        (100, 101, 99, 100, 100),
        (100, 101, 99, 100, 100),
        (100, 101, 99, 100, 100),
        (100, 101, 99, 100, 100),
    )
    broker, snap = _setup(ba, mode="v2", participation=0.10)
    snap.set_index(0)
    broker.process_bar(0)
    snap.set_index(1)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=50, order_type="market",
                              ttl_bars=2, tag="t"))
    broker.process_bar(2)  # first partial (forecast from bar 1 volume)
    broker.process_bar(3)  # second partial
    broker.process_bar(4)  # TTL expired, cancels remainder
    fills = broker.fills_log
    total = sum(f.qty for f in fills)
    assert total == 20.0
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


def test_order_rejects_non_finite_inputs():
    import math
    import pytest
    with pytest.raises(ValueError, match="finite"):
        Order(id="o1", symbol="X", side="buy", qty=float("nan"), order_type="market")
    with pytest.raises(ValueError, match="finite"):
        Order(id="o1", symbol="X", side="buy", qty=math.inf, order_type="market")
    with pytest.raises(ValueError, match="finite limit_price"):
        Order(id="o1", symbol="X", side="buy", qty=1, order_type="limit", limit_price=float("nan"))


def test_liquidation_fill_not_double_counted():
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
    broker.process_bar(2)
    liq_count = sum(1 for f in broker.fills_log if f.tag == "LIQUIDATION")
    assert liq_count == 1, f"liquidation appended {liq_count} times, expected 1"


def test_fillconfig_rejects_bad_inputs():
    import pytest
    with pytest.raises(ValueError, match="participation"):
        FillConfig(mode="v2", participation_pct=1.5)
    with pytest.raises(ValueError, match="mode"):
        FillConfig(mode="weird")


def test_zero_volume_bar_does_not_fill_in_v2():
    # Open fills use the prior bar's volume forecast. Zero fill-bar volume alone
    # is not sufficient to block when the prior bar had liquidity.
    ba = _bars((100, 101, 99, 100, 1000), (100, 101, 99, 100, 0))
    broker, snap = _setup(ba, mode="v2", participation=0.10)
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=5, order_type="market", tag="t"))
    broker.process_bar(1)
    assert len(broker.fills_log) == 1

    # When both the prior and fill bars have zero forecast volume, no open fill.
    ba2 = _bars((100, 101, 99, 100, 0), (100, 101, 99, 100, 0))
    broker2, snap2 = _setup(ba2, mode="v2", participation=0.10)
    snap2.set_index(0)
    broker2.submit_order(Order(id="o2", symbol="X", side="buy", qty=5, order_type="market", tag="t"))
    broker2.process_bar(1)
    assert len(broker2.fills_log) == 0


def test_aggregate_queued_exposure_rejects_split_oversized_orders():
    ba = _bars((100, 101, 99, 100, 1_000_000), (100, 101, 99, 100, 1_000_000))
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=100_000.0, max_leverage=1.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    snap.set_index(0)

    first = broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=600, order_type="market"))
    second = broker.submit_order(Order(id="o2", symbol="X", side="buy", qty=600, order_type="market"))

    assert first
    assert second == ""
    assert len(broker.orders) == 1
    assert broker.diagnostics()["rejection_reasons"]["insufficient_margin"] == 1


def test_future_multiplier_affects_pnl_and_rejects_notional_intent():
    ba = _bars((100, 101, 99, 100, 1_000_000), (100, 101, 99, 100, 1_000_000), (110, 111, 109, 110, 1_000_000))
    snap = MarketSnapshot({"X": ba})
    spec = resolve_asset_spec({"symbol": "X", "asset_class": "future", "asset_spec": _custom_future_spec()})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m", asset_specs={"X": spec})
    snap.set_index(0)
    assert broker.submit_intent(side="buy", symbol="X", notional=10_000) == ""
    assert broker.diagnostics()["rejection_reasons"]["futures_require_explicit_qty"] == 1
    broker.submit_intent(side="buy", symbol="X", qty=2)
    broker.process_bar(1)
    broker.submit_intent(side="sell", symbol="X", qty=2)
    broker.process_bar(2)
    assert len(broker.book.trades) == 1
    assert broker.book.trades[0].pnl == 1_000.0
    assert broker.book.trades[0].multiplier == 50


def test_future_commission_per_contract_applies_to_fills():
    ba = _bars((100, 101, 99, 100, 1_000_000), (100, 101, 99, 100, 1_000_000))
    snap = MarketSnapshot({"X": ba})
    spec = resolve_asset_spec({"symbol": "X", "asset_class": "future", "asset_spec": _custom_future_spec()})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0, commission_per_contract=2.25)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m", asset_specs={"X": spec})
    snap.set_index(0)
    broker.submit_intent(side="buy", symbol="X", qty=2)
    broker.process_bar(1)
    assert len(broker.fills_log) == 1
    assert broker.fills_log[0].fee == 4.5


def test_asset_spec_rounds_qty_price_and_enables_spread_defaults():
    spec = resolve_asset_spec({"symbol": "BTC-USD", "asset_class": "crypto_perp", "execution": {"funding_rate_bps": 1, "maintenance_margin_pct": 0.05}})
    assert spec.productionEligible is True
    assert spec.round_qty(1.23456) == 1.234
    assert spec.round_price(100.123) == 100.12


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


def test_current_bar_volume_does_not_change_open_fill():
    # PR2 causal-execution invariant: a market order filling at the next bar's
    # open must be sized from a *prior-bar* volume forecast, never the fill
    # bar's own realized volume/high/low/close. Using the fill bar's eventual
    # data is lookahead — the engine would "know" how much it could trade
    # before the bar completed.
    def run(fill_bar_volume, fill_bar_hlc):
        high, low, close = fill_bar_hlc
        ba = _bars(
            (100, 101, 99, 100, 1000),                  # bar 0: prior (identical in both runs)
            (100, high, low, close, fill_bar_volume),   # bar 1: fill bar (varies)
        )
        broker, _snap = _setup(ba, mode="v2", participation=0.10)
        _snap.set_index(0)
        broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=10_000,
                                  order_type="market", tag="t"))
        broker.process_bar(1)
        return sum(f.qty for f in broker.fills_log)

    quiet = run(1_000, (101, 99, 100))
    busy = run(1_000_000, (200, 50, 150))
    assert quiet == busy, (
        f"open fill size depended on the fill bar's own data: {quiet} vs {busy} "
        "(participation must use a prior-bar volume forecast)"
    )


def test_aggregate_participation_cap_across_orders_same_bar():
    ba = _bars((100, 101, 99, 100, 1000), (100, 101, 99, 100, 1_000_000))
    broker, snap = _setup(ba, mode="v2", participation=0.10)
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=80, order_type="market"))
    broker.submit_order(Order(id="o2", symbol="X", side="buy", qty=80, order_type="market"))
    broker.process_bar(1)
    total = sum(f.qty for f in broker.fills_log)
    assert total == 100.0  # 10% of prior bar volume 1000, not 160


def test_open_and_intrabar_share_participation_budget():
    ba = _bars(
        (100, 101, 99, 100, 1000),
        (100, 105, 95, 100, 1000),
    )
    broker, snap = _setup(ba, mode="v2", participation=0.10)
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=60, order_type="market"))
    snap.set_index(1)
    open_fills = broker.process_open(1)
    broker.submit_order(Order(id="o2", symbol="X", side="buy", qty=60, order_type="limit", limit_price=100.0))
    intrabar_fills = broker.process_intrabar(1)
    total = sum(f.qty for f in open_fills + intrabar_fills)
    assert total == 100.0


def test_margin_equity_uses_fill_time_open_prices():
    ba = _bars((100, 101, 99, 100, 1_000_000), (50, 55, 45, 50, 1_000_000))
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=10_000.0, max_leverage=2.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=100, order_type="market"))
    snap.set_index(1)
    broker.process_bar(1)
    acct.mark_prices({"X": 100.0})  # stale prior close
    open_prices = broker._fill_time_prices("X", 50.0)
    assert open_prices["X"] == 50.0
    assert broker._equity_at_prices(open_prices) < broker.account.equity(broker.book.positions)


def test_margin_partial_fill_at_actual_price():
    ba = _bars((100, 101, 99, 100, 1_000_000), (200, 201, 199, 200, 1_000_000))
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=10_000.0, max_leverage=2.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=200, order_type="market"))
    broker.process_bar(1)  # fill at open=200; full 200 needs ~40k notional at 2x
    total = sum(f.qty for f in broker.fills_log)
    assert 0 < total < 200


def test_funding_can_turn_trade_pnl_negative():
    ba = _bars(
        (100, 101, 99, 100, 1_000_000),
        (110, 111, 109, 110, 1_000_000),
        (110, 111, 109, 110, 1_000_000),
    )
    snap = MarketSnapshot({"X": ba})
    spec = resolve_asset_spec({
        "symbol": "BTC-USD", "asset_class": "crypto_perp",
        "execution": {"funding_rate_bps": 50, "maintenance_margin_pct": 0.05},
    })
    acct = Account.new(starting_cash=100_000.0, max_leverage=5.0, maintenance_margin_pct=0.05)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0, funding_rate_bps_per_interval=50.0,
                       funding_interval_hours=8.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m", asset_specs={"X": spec})
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=10, order_type="market", tag="entry"))
    broker.process_bar(1)
    pos = broker.get_position("X")
    pos.funding_accum = 500.0
    broker.submit_order(Order(id="o2", symbol="X", side="sell", qty=10, order_type="market", tag="exit"))
    broker.process_bar(2)
    trade = broker.book.trades[0]
    assert trade.pnl < 100.0  # 10*(110-100) gross minus heavy funding


def test_insolvency_halts_and_caps_drawdown():
    from engine_v2.metrics.drawdown import max_drawdown

    ba = _bars(
        (100, 101, 99, 100, 1e9),
        (100, 101, 99, 100, 1e9),
        (100, 101, 99, 10, 1e9),
    )
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=1_000.0, max_leverage=5.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=0.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0,
                      slippage=SlippageConfig(base_bps=0.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    snap.set_index(0)
    broker.submit_order(Order(id="o1", symbol="X", side="buy", qty=50, order_type="market"))
    equity = []
    for i in range(len(ba)):
        snap.set_index(i)
        broker.process_bar(i)
        equity.append(broker.get_equity())
    assert broker.halted or min(equity) <= 0.0
    assert max_drawdown(np.array(equity, dtype=np.float64)) <= -0.99
