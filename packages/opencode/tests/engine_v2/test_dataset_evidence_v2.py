import numpy as np
import pandas as pd
import pytest

from engine_v2.data.calendars import (
    CALENDAR_VERSION,
    ExpectedTimestampRequest,
    expected_timestamps,
    requested_input_start,
)
from engine_v2.data.quality import analyze, blocking_reasons


def _rows(timestamps: pd.DatetimeIndex) -> pd.DataFrame:
    size = len(timestamps)
    return pd.DataFrame({
        "timestamp": timestamps,
        "open": np.full(size, 100.0),
        "high": np.full(size, 101.0),
        "low": np.full(size, 99.0),
        "close": np.full(size, 100.5),
        "volume": np.full(size, 1000.0),
    })


def _expected(start: str, end: str, interval: str, asset_class: str) -> pd.DatetimeIndex:
    return expected_timestamps(ExpectedTimestampRequest(start, end, interval, asset_class))


def test_missing_one_expected_five_minute_nyse_bar_is_exact_strict_blocker():
    expected = _expected("2024-01-02", "2024-01-02", "5m", "equity")
    missing = expected[17]
    report = analyze(
        _rows(expected.delete(17)), "5m", "equity", requested_start="2024-01-02", requested_end="2024-01-02"
    )
    assert report.expected_timestamp_count == 78
    assert report.actual_timestamp_count == 77
    assert report.coverage_pct == pytest.approx(77 / 78)
    assert report.missing_timestamps == [missing.isoformat()]
    assert report.missing_ranges == [{"start": missing.isoformat(), "end": missing.isoformat(), "count": 1}]
    assert "1 expected timestamp(s) missing" in blocking_reasons(report, "equity")


def test_two_sparse_daily_bars_do_not_look_complete_for_month():
    rows = _rows(pd.DatetimeIndex(["2024-01-02T00:00:00Z", "2024-01-31T00:00:00Z"]))
    report = analyze(rows, "1d", "equity", requested_start="2024-01-01", requested_end="2024-01-31")
    assert report.expected_timestamp_count == 21
    assert report.actual_timestamp_count == 2
    assert report.missing_timestamp_count == 19
    assert report.coverage_pct == pytest.approx(2 / 21)
    assert blocking_reasons(report, "equity")


def test_nyse_holiday_half_day_and_dst_are_explicit():
    holiday = _expected("2024-07-04", "2024-07-04", "5m", "equity")
    half_day = _expected("2024-07-03", "2024-07-03", "5m", "equity")
    around_dst = _expected("2024-03-08", "2024-03-11", "1h", "equity")
    assert len(holiday) == 0
    assert len(half_day) == 42
    assert half_day[0].isoformat() == "2024-07-03T13:30:00+00:00"
    assert half_day[-1].isoformat() == "2024-07-03T16:55:00+00:00"
    assert "2024-03-08T14:30:00+00:00" in {value.isoformat() for value in around_dst}
    assert "2024-03-11T13:30:00+00:00" in {value.isoformat() for value in around_dst}


def test_regular_session_reports_pre_and_post_market_as_extra():
    expected = _expected("2024-01-02", "2024-01-02", "1h", "equity")
    actual = expected.append(pd.DatetimeIndex(["2024-01-02T12:30:00Z", "2024-01-02T22:30:00Z"]))
    report = analyze(
        _rows(actual.sort_values()), "1h", "equity", requested_start="2024-01-02", requested_end="2024-01-02"
    )
    assert report.missing_timestamp_count == 0
    assert report.extra_timestamp_count == 2
    assert "2 timestamp(s) outside expected calendar/session" in blocking_reasons(report, "equity")


def test_24_7_crypto_has_no_weekend_closure():
    expected = _expected("2024-01-06", "2024-01-07", "1h", "crypto_spot")
    assert len(expected) == 48
    report = analyze(
        _rows(expected), "1h", "crypto_spot", requested_start="2024-01-06", requested_end="2024-01-07"
    )
    assert report.coverage_pct == 1.0
    assert blocking_reasons(report, "crypto_spot") == []


def test_exact_crypto_qualification_phase_does_not_expand_to_full_days():
    start = "2026-01-27T00:01:00Z"
    end = "2026-05-16T19:13:00Z"
    expected = _expected(start, end, "1m", "crypto")
    report = analyze(
        _rows(expected),
        "1m",
        "crypto",
        requested_start=start,
        requested_end=end,
    )
    assert len(expected) == 158113
    assert expected[0].isoformat() == "2026-01-27T00:01:00+00:00"
    assert expected[-1].isoformat() == "2026-05-16T19:13:00+00:00"
    assert report.missing_timestamp_count == 0
    assert report.extra_timestamp_count == 0
    assert blocking_reasons(report, "crypto") == []


def test_overnight_futures_session_starts_on_sunday_and_spans_dst():
    expected = _expected("2024-03-11", "2024-03-11", "1h", "future")
    assert len(expected) == 23
    assert expected[0].isoformat() == "2024-03-10T22:00:00+00:00"
    assert expected[-1].isoformat() == "2024-03-11T20:00:00+00:00"


def test_complete_monday_futures_session_preserves_sunday_open_through_cli_filter():
    request = ExpectedTimestampRequest("2024-03-11", "2024-03-11", "1h", "future")
    complete_session = expected_timestamps(request)
    filter_start = requested_input_start(request)
    filtered = _rows(complete_session)
    filtered = filtered[filtered["timestamp"] >= filter_start]
    report = analyze(
        filtered,
        "1h",
        "future",
        requested_start="2024-03-11",
        requested_end="2024-03-11",
    )
    assert filter_start.isoformat() == "2024-03-10T22:00:00+00:00"
    assert len(filtered) == 23
    assert report.missing_timestamp_count == 0
    assert report.extra_timestamp_count == 0
    assert blocking_reasons(report, "future") == []


@pytest.mark.parametrize("position", [0, 12, -1])
def test_missing_first_middle_or_last_bar_is_blocking(position: int):
    expected = _expected("2024-01-02", "2024-01-02", "15m", "equity")
    report = analyze(
        _rows(expected.delete(position)), "15m", "equity", requested_start="2024-01-02", requested_end="2024-01-02"
    )
    assert report.missing_timestamp_count == 1
    assert any("expected timestamp" in reason for reason in blocking_reasons(report, "equity"))


def test_incomplete_final_candle_blocks_strict():
    expected = _expected("2024-01-02", "2024-01-02", "15m", "equity")
    report = analyze(
        _rows(expected),
        "15m",
        "equity",
        requested_start="2024-01-02",
        requested_end="2024-01-02",
        incomplete_final_bar_count=1,
    )
    assert report.calendar_version == CALENDAR_VERSION
    assert "final candle is incomplete" in blocking_reasons(report, "equity")
