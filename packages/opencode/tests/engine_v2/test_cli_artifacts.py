from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _row_count(path: Path) -> int:
    with path.open(newline="") as f:
        return sum(1 for _ in csv.DictReader(f))


def test_strict_shapec_run_persists_order_and_fill_ledgers(tmp_path):
    data = tmp_path / "spy.csv"
    data.write_text(
        "\n".join([
            "timestamp,open,high,low,close,volume",
            "2026-01-05T14:30:00Z,100,101,99,100,1000000",
            "2026-01-06T14:30:00Z,101,102,100,101,1000000",
            "2026-01-07T14:30:00Z,102,103,101,102,1000000",
            "2026-01-08T14:30:00Z,103,104,102,103,1000000",
            "2026-01-09T14:30:00Z,104,105,103,104,1000000",
        ])
    )
    config = tmp_path / "config.json"
    config.write_text(json.dumps({
        "symbol": "SPY",
        "asset_class": "equity",
        "interval": "1d",
        "risk": {"starting_equity_usd": 10000},
    }))
    strategy = tmp_path / "strategy.py"
    strategy.write_text("""
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.n = 0

    def on_bar(self, symbol, bar):
        if self.n == 0:
            self.broker.buy(symbol, qty=1, tag="entry")
        elif self.n == 2:
            self.broker.sell(symbol, qty=1, tag="exit")
        self.n += 1
""")
    out = tmp_path / "out"
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    subprocess.run(
        [
            sys.executable,
            "-m",
            "engine_v2.cli",
            "--csv",
            str(data),
            "--config",
            str(config),
            "--interval",
            "1d",
            "--capital",
            "10000",
            "--out",
            str(out),
            "--strategy",
            str(strategy),
        ],
        cwd=ROOT,
        env=env,
        check=True,
        text=True,
        capture_output=True,
    )

    assert _row_count(out / "orders.csv") >= 4
    assert _row_count(out / "fills.csv") >= 2
    assert _row_count(out / "trades.csv") == 1
    fills = list(csv.DictReader((out / "fills.csv").open(newline="")))
    orders = list(csv.DictReader((out / "orders.csv").open(newline="")))
    assert {row["order_id"] for row in fills} <= {row["order_id"] for row in orders if row["order_id"]}
    assert {"submitted", "filled"} <= {row["status"] for row in orders}
