from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
from pathlib import Path

import pandas as pd

from engine_v2.cli import _filter_requested_window, _load_csv


ROOT = Path(__file__).resolve().parents[2]


def test_timestamp_window_is_exact_while_date_window_includes_the_day():
    df = pd.DataFrame({
        "timestamp": pd.to_datetime([
            "2026-01-05T14:30:00Z",
            "2026-01-05T14:35:00Z",
            "2026-01-05T14:40:00Z",
            "2026-01-06T14:30:00Z",
        ], utc=True),
    })
    exact = _filter_requested_window(df, "2026-01-05T14:35:00Z", "2026-01-05T14:40:00Z")
    whole_day = _filter_requested_window(df, "2026-01-05", "2026-01-05")
    assert list(exact["timestamp"].dt.strftime("%H:%M")) == ["14:35", "14:40"]
    assert list(whole_day["timestamp"].dt.strftime("%H:%M")) == ["14:30", "14:35", "14:40"]


def test_load_csv_infers_binance_epoch_milliseconds_before_date_filter(tmp_path):
    data = tmp_path / "btc-ms.csv"
    data.write_text(
        "\n".join([
            "timestamp,open,high,low,close,volume",
            "1752537600000,100,101,99,100,10",
            "1784073600000,80,81,79,80,12",
        ])
    )

    loaded = _load_csv(data)
    filtered = _filter_requested_window(loaded, "2025-07-15", "2026-07-15")

    assert list(filtered["timestamp"].dt.strftime("%Y-%m-%d")) == ["2025-07-15", "2026-07-15"]


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
            "--cost-sensitivity",
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
    results = json.loads((out / "results.json").read_text())
    cost_sensitivity = next(
        outcome for outcome in results["sensitivity_outcomes"]
        if outcome["name"] == "Cost/fee/slippage stress"
    )
    assert cost_sensitivity["status"] == "pass"
    assert cost_sensitivity["value"] > 0


def test_strict_run_records_contract_drawdown_flatten(tmp_path):
    data = tmp_path / "spy-risk.csv"
    data.write_text(
        "\n".join([
            "timestamp,open,high,low,close,volume",
            "2026-01-05T14:30:00Z,100,101,99,100,1000000",
            "2026-01-06T14:30:00Z,100,121,99,120,1000000",
            "2026-01-07T14:30:00Z,120,121,89,90,1000000",
            "2026-01-08T14:30:00Z,80,81,79,80,1000000",
            "2026-01-09T14:30:00Z,80,81,79,80,1000000",
        ])
    )
    config = tmp_path / "config-risk.json"
    config.write_text(json.dumps({
        "symbol": "SPY",
        "asset_class": "equity",
        "interval": "1d",
        "risk": {"starting_equity_usd": 100000},
        "risk_contract": {
            "sizing_stop_distance_pct": 2,
            "protective_stop": {"mode": "strategy_next_open"},
            "drawdown": {"mode": "halt_and_flatten_next_open", "limit_pct": 10},
            "max_positions": 1,
        },
    }))
    strategy = tmp_path / "strategy-risk.py"
    strategy.write_text("""
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.n = 0

    def on_bar(self, symbol, bar):
        if self.n == 0:
            self.broker.buy(symbol, qty=900)
        self.n += 1
""")
    out = tmp_path / "out-risk"
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
            "100000",
            "--out",
            str(out),
            "--strategy",
            str(strategy),
            "--mode",
            "v2",
            "--mc-paths",
            "0",
        ],
        cwd=ROOT,
        env=env,
        check=True,
        text=True,
        capture_output=True,
    )

    results = json.loads((out / "results.json").read_text())
    trigger = results["diagnostics"]["drawdown_trigger"]
    assert trigger["bar_index"] == 2
    assert trigger["flatten_execution_bar"] == 3
    assert trigger["flatten_status"] == "completed"
    assert trigger["flatten_fees"] > 0
    assert results["open_trades"] == []
    fills = list(csv.DictReader((out / "fills.csv").open(newline="")))
    assert any(row["tag"] == "DRAWDOWN_FLATTEN" for row in fills)
