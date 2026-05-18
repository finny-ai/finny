#!/usr/bin/env python3
"""CLI entry point for the data extractor. Called by the TS tool via subprocess.

Usage:
    python -m engine_v2.data.extract_cli \
        --symbol BTC/USD --interval 1h \
        --start 2024-01-01 --end 2024-03-01 \
        --algo-dir /path/to/algo

Outputs JSON to stdout — the TS tool parses it.
"""

from __future__ import annotations

import argparse
import json
import sys

def main() -> None:
    parser = argparse.ArgumentParser(description="Finny data extractor")
    parser.add_argument("--symbol", required=True, help="Symbol (e.g. BTC/USD, AAPL)")
    parser.add_argument("--interval", required=True, help="Bar interval (1m, 5m, 15m, 30m, 1h, 4h, 1d)")
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="End date YYYY-MM-DD")
    parser.add_argument("--algo-dir", required=True, help="Algo directory path")
    args = parser.parse_args()

    try:
        from engine_v2.data.extractor import extract, result_to_json
        result = extract(
            symbol=args.symbol,
            interval=args.interval,
            start=args.start,
            end=args.end,
            algo_dir=args.algo_dir,
        )
        print(result_to_json(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
