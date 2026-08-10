"""Session-grid alignment tests for the Alpaca equity provider.

Alpaca stamps intraday equity bars on wall-clock grids (hourly bars land on
whole hours, and the IEX feed includes extended-hours bars), while strict
qualification expects bars on the 09:30-anchored XNYS regular-session grid.
These tests lock the provider's granular-fetch + deterministic session
aggregation behavior: fetched 1m bars are re-binned onto the exact expected
timestamps so the strict coverage gate reconciles at 100%.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.data.calendars import ExpectedTimestampRequest, expected_timestamps
from engine_v2.data.providers.alpaca import AlpacaProvider, _session_aggregate
from engine_v2.data.quality import analyze


NY = "America/New_York"
REGULAR_DAYS = ("2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05")
HALF_DAY = "2024-11-29"  # day after Thanksgiving — scheduled 13:00 ET close


def _minute_value(ts: pd.Timestamp) -> int:
    local = ts.tz_convert(NY)
    return local.hour * 60 + local.minute


def _feed_minutes(day: str, start_hour: int = 4, end_hour: int = 20) -> pd.DataFrame:
    """1m bars covering extended hours for one day; OHLCV derives from the minute."""
    ts = pd.date_range(
        f"{day} {start_hour:02d}:00", f"{day} {end_hour - 1:02d}:59", freq="1min", tz=NY
    )
    m = np.array([_minute_value(t) for t in ts])
    return pd.DataFrame(
        {
            "timestamp": ts.tz_convert("UTC"),
            "open": 1000.0 + m,
            "high": 1000.0 + m + 2,
            "low": 1000.0 + m - 2,
            "close": 1000.0 + m + 1,
            "volume": m.astype(float),
        }
    )


def _feed_for_days(days: tuple[str, ...]) -> pd.DataFrame:
    return pd.concat([_feed_minutes(day) for day in days], ignore_index=True)


def _expected(interval: str, start: str, end: str) -> pd.DatetimeIndex:
    return expected_timestamps(
        ExpectedTimestampRequest(
            requested_start=start,
            requested_end=end,
            interval=interval,
            asset_class="equity",
        )
    )


def _utc(day: str, hour: int, minute: int = 0) -> pd.Timestamp:
    return pd.Timestamp(f"{day} {hour:02d}:{minute:02d}", tz=NY).tz_convert("UTC")


class TestSessionAggregate:
    def test_1h_bars_land_exactly_on_expected_session_grid(self):
        feed = _feed_for_days(REGULAR_DAYS)
        out = _session_aggregate(feed, "SPY", "2024-01-02", "2024-01-05", "1h")

        expected = _expected("1h", "2024-01-02", "2024-01-05")
        assert len(out) == 28  # 4 regular days x 7 session bars (09:30..15:30 ET)
        assert set(out["timestamp"]) == set(expected)
        assert list(out["timestamp"]) == list(expected)

    def test_1h_bucket_ohlcv_is_deterministic(self):
        out = _session_aggregate(
            _feed_for_days(REGULAR_DAYS), "SPY", "2024-01-02", "2024-01-05", "1h"
        )
        first_bin = out.loc[out["timestamp"] == _utc("2024-01-02", 9, 30)].iloc[0]

        # Bin [09:30, 10:30) ET covers minutes 570..629 (09:30:00..10:29:59).
        assert first_bin["open"] == pytest.approx(1000 + 570)
        assert first_bin["close"] == pytest.approx(1000 + 629 + 1)
        assert first_bin["high"] == pytest.approx(1000 + 629 + 2)
        assert first_bin["low"] == pytest.approx(1000 + 570 - 2)
        assert first_bin["volume"] == pytest.approx(sum(range(570, 630)))

        # Last session bin starts at 15:30 ET but closes at 16:00: it covers
        # minutes 930..959 and must NOT absorb after-hours 1m bars.
        last_bin = out.loc[out["timestamp"] == _utc("2024-01-02", 15, 30)].iloc[0]
        assert last_bin["open"] == pytest.approx(1000 + 930)
        assert last_bin["close"] == pytest.approx(1000 + 959 + 1)
        assert last_bin["volume"] == pytest.approx(sum(range(930, 960)))

    def test_extended_hours_bars_are_dropped(self):
        feed = _feed_for_days(REGULAR_DAYS)
        out = _session_aggregate(feed, "SPY", "2024-01-02", "2024-01-05", "1h")

        timestamps = set(out["timestamp"])
        # 09:29 ET pre-market bar and 16:00 ET after-hours bar must not appear.
        assert _utc("2024-01-02", 9, 29) not in timestamps
        assert _utc("2024-01-02", 16, 0) not in timestamps
        assert _utc("2024-01-02", 4, 0) not in timestamps
        assert _utc("2024-01-02", 19, 59) not in timestamps

    def test_half_day_uses_scheduled_early_close_grid(self):
        feed = _feed_minutes(HALF_DAY)
        out = _session_aggregate(feed, "SPY", HALF_DAY, HALF_DAY, "1h")

        expected = _expected("1h", HALF_DAY, HALF_DAY)
        assert len(expected) == 4  # 09:30, 10:30, 11:30, 12:30 ET
        assert set(out["timestamp"]) == set(expected)

        twelve_thirty = out.loc[out["timestamp"] == _utc(HALF_DAY, 12, 30)].iloc[0]
        # 12:30 ET bin covers minutes 750..779 (12:30..12:59, 13:00 close).
        assert twelve_thirty["open"] == pytest.approx(1000 + 750)
        assert twelve_thirty["close"] == pytest.approx(1000 + 779 + 1)
        assert twelve_thirty["volume"] == pytest.approx(sum(range(750, 780)))

    def test_4h_uses_session_grid(self):
        feed = _feed_for_days(REGULAR_DAYS)
        out = _session_aggregate(feed, "SPY", "2024-01-02", "2024-01-05", "4h")

        expected = _expected("4h", "2024-01-02", "2024-01-05")
        assert len(expected) == 8  # 09:30 and 13:30 per regular day
        assert set(out["timestamp"]) == set(expected)

    def test_aggregated_output_passes_strict_coverage(self):
        for interval in ("1h", "4h"):
            out = _session_aggregate(
                _feed_for_days(REGULAR_DAYS), "SPY", "2024-01-02", "2024-01-05", interval
            )
            report = analyze(
                out, interval, "equity", provider="alpaca",
                requested_start="2024-01-02", requested_end="2024-01-05",
            )
            assert report.coverage_pct == pytest.approx(1.0)
            assert report.missing_timestamp_count == 0
            assert report.extra_timestamp_count == 0

    def test_regional_symbols_keep_native_timestamps(self):
        # Provider-level note: fetch() rejects regional suffixes (e.g.
        # RELIANCE.NS) via _is_equity_symbol before aggregation, so this
        # exercises the calendar guard in _session_aggregate directly.
        feed = _feed_minutes(REGULAR_DAYS[0])
        out = _session_aggregate(feed, "RELIANCE.NS", "2024-01-02", "2024-01-02", "1h")
        assert out is feed  # passthrough, no re-binning

    def test_duplicate_identical_rows_are_deduped(self):
        feed = _feed_minutes(REGULAR_DAYS[0])
        feed = feed[feed["timestamp"] >= _utc("2024-01-02", 9, 30)].head(2)
        dup = pd.concat([feed, feed.iloc[[0]]], ignore_index=True)  # byte-identical 09:30 bar
        out = _session_aggregate(dup, "SPY", "2024-01-02", "2024-01-02", "1h")
        assert len(out) == 1
        expected_volume = feed["volume"].iloc[0] + feed["volume"].iloc[1]
        assert out["volume"].iloc[0] == pytest.approx(expected_volume)

    def test_duplicate_conflicting_rows_fail_closed(self):
        feed = _feed_minutes(REGULAR_DAYS[0]).head(1)
        conflicting = feed.copy()
        conflicting.loc[conflicting.index[0], "volume"] = conflicting["volume"].iloc[0] + 1.0
        dup = pd.concat([feed, conflicting], ignore_index=True)
        with pytest.raises(RuntimeError, match="conflicting duplicate bars"):
            _session_aggregate(dup, "SPY", "2024-01-02", "2024-01-02", "1h")

    def test_incomplete_trailing_bucket_omitted_at_timestamp_end(self):
        feed = _feed_minutes(REGULAR_DAYS[0])  # full 1m day, incl. extended hours
        end = "2024-01-02T15:45:00+00:00"  # 10:45 ET: the 10:30 bucket has 15 min
        out = _session_aggregate(feed, "SPY", "2024-01-02", end, "1h")

        expected = _expected("1h", "2024-01-02", end)
        assert set(expected) == {_utc("2024-01-02", 9, 30), _utc("2024-01-02", 10, 30)}
        assert set(out["timestamp"]) == {_utc("2024-01-02", 9, 30)}  # 10:30 omitted

        report = analyze(
            out, "1h", "equity", provider="alpaca",
            requested_start="2024-01-02", requested_end=end,
        )
        assert report.coverage_pct == pytest.approx(0.5)
        assert _utc("2024-01-02", 10, 30).isoformat() in report.missing_timestamps

    def test_dst_shifts_utc_labels(self):
        jan = _session_aggregate(
            _feed_minutes("2024-01-02"), "SPY", "2024-01-02", "2024-01-02", "1h"
        )
        jul = _session_aggregate(
            _feed_minutes("2024-07-10"), "SPY", "2024-07-10", "2024-07-10", "1h"
        )
        assert jan["timestamp"].iloc[0] == _utc("2024-01-02", 9, 30)  # 14:30Z (EST)
        assert jul["timestamp"].iloc[0] == _utc("2024-07-10", 9, 30)  # 13:30Z (EDT)
        assert jan["timestamp"].iloc[0].hour == 14
        assert jul["timestamp"].iloc[0].hour == 13


class TestAlpacaProviderFetch:
    def _fake_session(self, rows: list[dict], pages: int = 2):
        seen: list[dict] = []
        first = rows[: len(rows) // 2]
        rest = rows[len(rows) // 2:]

        class FakeResponse:
            def __init__(self, payload: dict):
                self._payload = payload

            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict:
                return self._payload

        def fake_get(url: str, params: dict, headers: dict, timeout: int):
            seen.append(params)
            payload_rows = rows if pages == 1 else (first if len(seen) == 1 else rest)
            next_token = "p2" if pages > 1 and len(seen) == 1 else None
            return FakeResponse({"bars": {"SPY": payload_rows}, "next_page_token": next_token})

        session = MagicMock()
        session.get.side_effect = fake_get
        return session, seen

    def _alpaca_rows(self, feed: pd.DataFrame) -> list[dict]:
        return [
            {
                "t": str(ts.isoformat()),
                "o": str(o), "h": str(h), "l": str(l), "c": str(c), "v": str(v),
            }
            for ts, o, h, l, c, v in zip(
                feed["timestamp"], feed["open"], feed["high"],
                feed["low"], feed["close"], feed["volume"],
            )
        ]

    def test_fetch_1h_requests_1m_and_aggregates(self, monkeypatch):
        monkeypatch.setenv("ALPACA_API_KEY_ID", "test-key")
        monkeypatch.setenv("ALPACA_API_SECRET_KEY", "test-secret")
        feed = _feed_for_days(REGULAR_DAYS)
        session, seen = self._fake_session(self._alpaca_rows(feed))

        with patch("requests.Session", return_value=session):
            df = AlpacaProvider().fetch("SPY", "2024-01-02", "2024-01-05", "1h")

        assert all(params["timeframe"] == "1Min" for params in seen)
        assert all(params["symbols"] == "SPY" for params in seen)
        assert seen[1]["page_token"] == "p2"
        assert len(df) == 28
        assert set(df["timestamp"]) == set(_expected("1h", "2024-01-02", "2024-01-05"))
        assert df["volume"].iloc[0] == pytest.approx(sum(range(570, 630)))

    def test_fetch_30m_keeps_native_timeframe(self, monkeypatch):
        monkeypatch.setenv("ALPACA_API_KEY_ID", "test-key")
        monkeypatch.setenv("ALPACA_API_SECRET_KEY", "test-secret")
        rows = [
            {"t": "2024-01-02T14:30:00+00:00", "o": "100", "h": "110", "l": "90", "c": "105", "v": "1000"},
            {"t": "2024-01-02T15:00:00+00:00", "o": "105", "h": "115", "l": "95", "c": "110", "v": "2000"},
        ]
        session, seen = self._fake_session(rows, pages=1)

        with patch("requests.Session", return_value=session):
            df = AlpacaProvider().fetch("SPY", "2024-01-02", "2024-01-05", "30m")

        assert seen[0]["timeframe"] == "30Min"
        assert len(df) == 2  # native bars pass through unaggregated

    def test_fetch_option_symbol_keeps_native_bars(self, monkeypatch):
        monkeypatch.setenv("ALPACA_API_KEY_ID", "test-key")
        monkeypatch.setenv("ALPACA_API_SECRET_KEY", "test-secret")
        rows = [
            {"t": "2024-01-02T15:00:00+00:00", "o": "1.0", "h": "1.2", "l": "0.9", "c": "1.1", "v": "50"},
        ]
        seen = []

        class FakeResponse:
            def raise_for_status(self) -> None:
                return None

            def json(self) -> dict:
                return {"bars": {"SPY260619C00500000": rows}, "next_page_token": None}

        def fake_get(url: str, params: dict, headers: dict, timeout: int):
            seen.append((url, params))
            return FakeResponse()

        session = MagicMock()
        session.get.side_effect = fake_get

        with patch("requests.Session", return_value=session):
            df = AlpacaProvider().fetch("SPY/20260619/500C", "2024-01-02", "2024-01-05", "1h")

        url, params = seen[0]
        assert "/v1beta1/options/bars" in url
        assert params["timeframe"] == "1Hour"  # no granular 1m reconstruction
        assert len(df) == 1

    def test_fetch_daily_keeps_native_bars(self, monkeypatch):
        monkeypatch.setenv("ALPACA_API_KEY_ID", "test-key")
        monkeypatch.setenv("ALPACA_API_SECRET_KEY", "test-secret")
        rows = [
            {"t": "2024-01-02T14:30:00+00:00", "o": "100", "h": "110", "l": "90", "c": "105", "v": "1000"},
            {"t": "2024-01-03T14:30:00+00:00", "o": "105", "h": "115", "l": "95", "c": "110", "v": "2000"},
        ]
        session, seen = self._fake_session(rows, pages=1)

        with patch("requests.Session", return_value=session):
            df = AlpacaProvider().fetch("SPY", "2024-01-02", "2024-01-05", "1d")

        assert seen[0]["timeframe"] == "1Day"
        assert len(df) == 2
        assert list(df["timestamp"]) == [
            pd.Timestamp("2024-01-02T14:30:00", tz="UTC"),
            pd.Timestamp("2024-01-03T14:30:00", tz="UTC"),
        ]
