"""Download Binance spot klines to a CSV for backtesting.

Uses the public Binance REST API (no auth).

Example:
  python3 fetch_binance_klines.py --symbol ETHUSDT --interval 15m --start-date 2025-03-02 --end-date 2026-03-02 --out ethusdt_15m.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, List, Optional, Tuple


BINANCE_BASE = "https://api.binance.com/api/v3/klines"


def _dt_utc(date_str: str) -> datetime:
    # YYYY-MM-DD -> UTC midnight
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return dt.replace(tzinfo=timezone.utc)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def fetch_klines(
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    limit: int = 1000,
    sleep_s: float = 0.2,
) -> List[List[Any]]:
    out: List[List[Any]] = []
    cur = int(start_ms)
    while cur < end_ms:
        params = {
            "symbol": symbol,
            "interval": interval,
            "startTime": cur,
            "endTime": end_ms,
            "limit": limit,
        }
        url = BINANCE_BASE + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "finny-backtest"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        if not data:
            break

        out.extend(data)
        last_open_time = int(data[-1][0])
        # advance by 1ms past last open time to avoid duplicates
        cur = last_open_time + 1
        time.sleep(sleep_s)

        # Safety: stop if Binance returns same last time repeatedly
        if len(data) < limit:
            break
    return out


def kline_to_row(k: List[Any]) -> Tuple[str, float, float, float, float, float]:
    # Binance kline array: [open_time, open, high, low, close, volume, close_time, ...]
    ts = datetime.fromtimestamp(int(k[0]) / 1000, tz=timezone.utc).isoformat()
    return (
        ts,
        float(k[1]),
        float(k[2]),
        float(k[3]),
        float(k[4]),
        float(k[5]),
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="ETHUSDT")
    ap.add_argument("--interval", default="15m")
    ap.add_argument("--start-date", required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--end-date", required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    start = _dt_utc(args.start_date)
    end = _dt_utc(args.end_date)
    # inclusive end date -> add 1 day
    end = end.replace(tzinfo=timezone.utc)
    end_ms = _ms(end) + 24 * 60 * 60 * 1000

    klines = fetch_klines(
        symbol=args.symbol,
        interval=args.interval,
        start_ms=_ms(start),
        end_ms=end_ms,
    )

    if not klines:
        raise SystemExit("No data returned from Binance")

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for k in klines:
            w.writerow(list(kline_to_row(k)))

    print(f"Wrote {len(klines)} rows to {args.out}")


if __name__ == "__main__":
    main()
