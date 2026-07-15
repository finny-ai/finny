from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np
import pandas as pd
import pytest

from engine_v2.assets import resolve_asset_spec
from engine_v2.core.arrays import BarArrays, MarketSnapshot
from engine_v2.data import quality as DQ
from engine_v2.data.extractor import _roll_adjust_futures
from engine_v2.execution.costs import CostConfig
from engine_v2.execution.fills import FillConfig
from engine_v2.execution.orders import Order
from engine_v2.execution.profiles import resolve_execution_profile
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
    return BarArrays(symbol="X", ts=ts, open=o, high=h, low=lows, close=c, volume=v, atr=np.ones(len(o)))


def test_execution_profile_defaults_disable_atr_and_emit_scenarios():
    state = resolve_execution_profile("equity", {})
    assert state["profile"]["id"] == "liquid_us_equity_v1"
    assert state["profile_defaults"]["k_atr"] == 0.0
    assert state["effective"]["k_atr"] == 0.0
    assert state["scenarios"]["zero_cost"]["slippage_bps"] == 0.0
    assert state["scenarios"]["base"]["k_atr"] == 0.0
    assert state["scenarios"]["stressed"]["k_atr"] > 0.0


def test_execution_profile_overrides_do_not_change_identity():
    state = resolve_execution_profile("crypto_spot", {"profile_id": "crypto_spot_v1", "slippage_bps": 9.0})
    assert state["profile"]["id"] == "crypto_spot_v1"
    assert state["profile_defaults"]["slippage_bps"] != 9.0
    assert state["effective"]["slippage_bps"] == 9.0
    assert state["overrides"] == {"slippage_bps": 9.0}
    with pytest.raises(ValueError, match="not crypto_spot"):
        resolve_execution_profile("crypto_spot", {"profile_id": "liquid_us_equity_v1"})


def test_symbol_asset_class_mismatch_requires_complete_custom_spec():
    with pytest.raises(ValueError, match="inconsistent"):
        resolve_asset_spec({"symbol": "BTC-USD", "asset_class": "equity"})
    spec = resolve_asset_spec({
        "symbol": "BTC-USD",
        "asset_class": "equity",
        "asset_spec": {
            "tickSize": 0.01,
            "lotSize": 1,
            "multiplier": 1,
            "calendar": "US_EQUITIES",
            "currency": "USD",
            "feeModel": "custom",
            "marginModel": "custom",
            "dataProvider": "custom",
        },
    })
    assert spec.assetClass == "equity"


def _equity_intraday_rows(start: str, periods: int) -> pd.DataFrame:
    ts = pd.date_range(start, periods=periods, freq="15min", tz="UTC")
    return pd.DataFrame({
        "timestamp": ts,
        "open": np.full(len(ts), 100.0),
        "high": np.full(len(ts), 101.0),
        "low": np.full(len(ts), 99.0),
        "close": np.full(len(ts), 100.0),
        "volume": np.full(len(ts), 1000.0),
    })


def _coverage_blocking_reasons(periods: int) -> tuple[float, list[str]]:
    report = DQ.analyze(_equity_intraday_rows("2024-01-02 14:30", periods), "15min", "equity", provider="test")
    return report.coverage_pct, DQ.blocking_reasons(report, "equity")


def _assert_coverage_expectation(periods: int, expect_truncated: bool) -> None:
    coverage_pct, reasons = _coverage_blocking_reasons(periods)
    has_coverage_block = any("coverage" in reason for reason in reasons)
    assert (coverage_pct < 1.0) == expect_truncated
    assert has_coverage_block == expect_truncated


@pytest.mark.parametrize("periods,expect_truncated", [(10, True), (26, False)])
def test_exchange_calendar_coverage_for_equity_session(periods: int, expect_truncated: bool):
    _assert_coverage_expectation(periods, expect_truncated)


def test_requested_window_allows_weekend_start_for_equity():
    reasons = DQ.requested_window_reasons(
        _equity_intraday_rows("2024-01-08 14:30", 10),
        "15min",
        "equity",
        requested_start="2024-01-07",
        requested_end=None,
    )
    assert reasons == []


def _equity_daily_rows(start: str, periods: int) -> pd.DataFrame:
    ts = pd.date_range(start, periods=periods, freq="B", tz="UTC")
    return pd.DataFrame({
        "timestamp": ts,
        "open": np.full(len(ts), 100.0),
        "high": np.full(len(ts), 101.0),
        "low": np.full(len(ts), 99.0),
        "close": np.full(len(ts), 100.0),
        "volume": np.full(len(ts), 1000.0),
    })


def _equity_end_reasons(requested_end: str, now: str, last_bar_day: str = "2024-01-08") -> list[str]:
    periods = pd.bdate_range("2024-01-02", last_bar_day).size
    return DQ.requested_window_reasons(
        _equity_daily_rows("2024-01-02", periods),
        "1d",
        "equity",
        requested_start="2024-01-02",
        requested_end=requested_end,
        now=pd.Timestamp(now, tz="UTC"),
    )


def test_requested_end_today_before_close_does_not_block_equity():
    # Mon 2024-01-08 is the last completed bar; end requested for Tue 01-09
    # while Tuesday's session is still open (15:00 UTC = 10:00 ET).
    assert _equity_end_reasons("2024-01-09", now="2024-01-09 15:00") == []


def test_requested_end_today_after_close_still_blocks_truncated_equity():
    # Same window, but Tuesday's session has closed (22:00 UTC = 17:00 ET),
    # so a missing Tuesday bar is a genuinely truncated provider window.
    reasons = _equity_end_reasons("2024-01-09", now="2024-01-09 22:00")
    assert len(reasons) == 1 and "before requested end" in reasons[0]


def test_requested_end_on_weekend_does_not_block_equity():
    # Fri 2024-01-05 is the last bar; requested end lands on Sat 01-06.
    assert _equity_end_reasons("2024-01-06", now="2024-01-06 12:00", last_bar_day="2024-01-05") == []


def test_requested_end_in_past_still_blocks_truncated_equity():
    reasons = _equity_end_reasons("2024-01-12", now="2024-02-01 00:00")
    assert len(reasons) == 1 and "before requested end" in reasons[0]


def test_requested_end_on_july4_holiday_does_not_block_equity():
    # Thu 2024-07-04 is a NYSE holiday; Wed 07-03 is the last real session.
    assert _equity_end_reasons("2024-07-04", now="2024-07-05 00:00", last_bar_day="2024-07-03") == []


def test_requested_end_on_good_friday_does_not_block_equity():
    # Fri 2024-03-29 is Good Friday (NYSE closed, not a federal holiday).
    assert _equity_end_reasons("2024-03-29", now="2024-03-30 12:00", last_bar_day="2024-03-28") == []


def test_requested_end_rolls_back_over_weekend_and_holiday_chain():
    # Fri 2025-07-04 is a NYSE holiday; requested end Sun 07-06 must roll
    # back through the weekend and the holiday to Thu 07-03.
    assert _equity_end_reasons("2025-07-06", now="2025-07-07 00:00", last_bar_day="2025-07-03") == []


def test_truncated_before_holiday_still_blocks_equity():
    # Last bar Tue 07-02 with end 07-04: Wed 07-03 was a full session that
    # is genuinely missing, so strict mode must still block.
    reasons = _equity_end_reasons("2024-07-04", now="2024-07-05 00:00", last_bar_day="2024-07-02")
    assert len(reasons) == 1 and "before requested end" in reasons[0]


def test_requested_start_on_holiday_does_not_block_equity():
    # Mon 2024-01-01 (New Year's) start with the first bar on Tue 01-02.
    reasons = DQ.requested_window_reasons(
        _equity_intraday_rows("2024-01-02 14:30", 10),
        "15min",
        "equity",
        requested_start="2024-01-01",
        requested_end=None,
    )
    assert reasons == []


def test_exchange_coverage_skips_market_holiday():
    # Jul 3 is a scheduled 13:00 ET half-day (14 x 15min bars) and Jul 5 is a
    # full session (26 bars). Jul 4 contributes no expected timestamps.
    df = pd.concat(
        [
            _equity_intraday_rows("2024-07-03 13:30", 14),
            _equity_intraday_rows("2024-07-05 13:30", 26),
        ],
        ignore_index=True,
    )
    report = DQ.analyze(df, "15min", "equity", provider="test")
    assert report.coverage_pct == 1.0
    assert DQ.blocking_reasons(report, "equity") == []


def _crypto_daily_rows(start: str, periods: int) -> pd.DataFrame:
    ts = pd.date_range(start, periods=periods, freq="D", tz="UTC")
    return pd.DataFrame({
        "timestamp": ts,
        "open": np.full(len(ts), 100.0),
        "high": np.full(len(ts), 101.0),
        "low": np.full(len(ts), 99.0),
        "close": np.full(len(ts), 100.0),
        "volume": np.full(len(ts), 1000.0),
    })


def _crypto_end_reasons(periods: int, requested_end: str, now: str) -> list[str]:
    return DQ.requested_window_reasons(
        _crypto_daily_rows("2024-01-01", periods),
        "1d",
        "crypto_spot",
        requested_start="2024-01-01",
        requested_end=requested_end,
        now=pd.Timestamp(now, tz="UTC"),
    )


def test_requested_end_today_does_not_block_crypto_daily():
    # Last completed daily bar is 2024-01-08 00:00 UTC; the 01-09 bar is
    # still forming at mid-day, so requesting end=today must not block.
    assert _crypto_end_reasons(8, "2024-01-09", now="2024-01-09 12:00") == []


def test_truncated_crypto_daily_still_blocks():
    reasons = _crypto_end_reasons(5, "2024-01-09", now="2024-01-09 12:00")
    assert len(reasons) == 1 and "before requested end" in reasons[0]


def _fetch_end(requested_end: str, interval: str, asset_class: str, now: str) -> str:
    ts = DQ.completed_window_exclusive_end(requested_end, interval, asset_class, now=pd.Timestamp(now, tz="UTC"))
    return ts.isoformat()


def test_fetch_end_includes_the_end_days_bars_for_past_windows():
    # The requested end DATE must be fetched through its end-of-day, not
    # truncated at its midnight — otherwise every strict backtest is missing
    # its final session and blocks.
    assert _fetch_end("2024-01-10", "15m", "equity", now="2024-02-01 00:00") == "2024-01-11T00:00:00+00:00"


def test_fetch_end_excludes_todays_open_equity_session():
    # Tue 2024-01-09 15:00 UTC = 10:00 ET, session still open: cap at the end
    # of Mon 01-08, matching what the strict gate will demand.
    assert _fetch_end("2024-01-09", "15m", "equity", now="2024-01-09 15:00") == "2024-01-09T00:00:00+00:00"


def test_fetch_end_includes_today_after_equity_close():
    # 22:00 UTC = 17:00 ET, session closed: today's bars are completable.
    assert _fetch_end("2024-01-09", "15m", "equity", now="2024-01-09 22:00") == "2024-01-10T00:00:00+00:00"


def test_fetch_end_caps_at_last_session_over_weekend_and_holiday():
    # End Sun 2025-07-06 with Fri 07-04 a NYSE holiday: fetch through Thu 07-03.
    assert _fetch_end("2025-07-06", "1d", "equity", now="2025-07-07 00:00") == "2025-07-04T00:00:00+00:00"


def test_fetch_end_excludes_in_progress_crypto_daily_bar():
    assert _fetch_end("2024-01-09", "1d", "crypto_spot", now="2024-01-09 12:00") == "2024-01-09T00:00:00+00:00"


def test_fetch_end_floors_to_last_completed_crypto_intraday_bar():
    assert _fetch_end("2024-01-09", "15m", "crypto_spot", now="2024-01-09 12:07") == "2024-01-09T12:00:00+00:00"


def test_terminal_liquidation_nav_cancels_pending_and_closes_positions():
    ba = _bars((100, 100, 100, 100, 1_000_000), (100, 100, 100, 100, 1_000_000))
    snap = MarketSnapshot({"X": ba})
    acct = Account.new(starting_cash=100_000.0, max_leverage=10.0, maintenance_margin_pct=0.0)
    costs = CostConfig(maker_fee_bps=0.0, taker_fee_bps=10.0)
    fcfg = FillConfig(mode="v2", participation_pct=1.0, slippage=SlippageConfig(base_bps=10.0, k_atr=0.0, k_vol=0.0))
    broker = PortfolioBroker(snap, acct, costs, fcfg, interval="1m")
    snap.set_index(0)
    broker.submit_order(Order(id="entry", symbol="X", side="buy", qty=10, order_type="market"))
    broker.process_bar(1)
    broker.submit_order(Order(id="pending", symbol="X", side="buy", qty=1, order_type="market"))
    terminal = broker.terminal_liquidation_nav()
    assert terminal["canceled_pending_orders"] == 1
    assert len(terminal["hypothetical_closes"]) == 1
    assert terminal["nav"] < broker.get_equity()


def _roll_bar_values(i: int) -> tuple[float, float]:
    base = 100.0 + i + (20.0 if i >= 30 else 0.0) - (15.0 if i >= 60 else 0.0)
    volume = 5000.0 if i in {30, 60} else 1000.0
    return base, volume


def _multi_roll_futures_rows() -> pd.DataFrame:
    ts = pd.date_range("2024-01-01", periods=80, freq="D", tz="UTC")
    rows = []
    for i, t in enumerate(ts):
        base, volume = _roll_bar_values(i)
        rows.append({
            "timestamp": t,
            "open": base,
            "high": base + 1,
            "low": base - 1,
            "close": base,
            "volume": volume,
        })
    return pd.DataFrame(rows)


def test_multi_roll_back_adjustment_validates_every_boundary():
    adjusted, boundaries = _roll_adjust_futures(_multi_roll_futures_rows())
    assert len(boundaries) >= 2
    for boundary in boundaries:
        i = boundary.index
        assert abs(float(adjusted.loc[i, "open"]) - float(adjusted.loc[i - 1, "close"])) < 1e-8
