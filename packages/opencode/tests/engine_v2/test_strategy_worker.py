from __future__ import annotations

import pytest

from engine_v2.cli import StrictStrategyWorker


def _write_strategy(tmp_path, code: str):
    p = tmp_path / "strategy.py"
    p.write_text(code)
    return p


def test_worker_rejects_denied_import_at_runtime(tmp_path):
    strategy = _write_strategy(tmp_path, """import os

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        pass
""")
    with pytest.raises(SystemExit, match="not allowed"):
        StrictStrategyWorker(strategy, params={})


def test_worker_times_out_infinite_on_bar(tmp_path):
    strategy = _write_strategy(tmp_path, """class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        while True:
            pass
""")
    worker = StrictStrategyWorker(strategy, params={})
    try:
        with pytest.raises(SystemExit, match="timed out"):
            worker.on_bar(
                symbol="X",
                bar={"timestamp": "2026-01-01", "symbol": "X", "open": 100, "prev_close": 99, "volume": 1000},
                state={"positions": {"X": 0}, "cash": 10000, "equity": 10000, "prices": {"X": 100}},
                history={"X": []},
            )
    finally:
        worker.close()


def test_worker_rejects_too_many_orders(tmp_path):
    strategy = _write_strategy(tmp_path, """class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        for _ in range(101):
            self.broker.buy(symbol, qty=1)
""")
    worker = StrictStrategyWorker(strategy, params={})
    try:
        with pytest.raises(SystemExit, match="Too many orders"):
            worker.on_bar(
                symbol="X",
                bar={"timestamp": "2026-01-01", "symbol": "X", "open": 100, "prev_close": 99, "volume": 1000},
                state={"positions": {"X": 0}, "cash": 10000, "equity": 10000, "prices": {"X": 100}},
                history={"X": []},
            )
    finally:
        worker.close()
