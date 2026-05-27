from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.data.extractor import extract


STRATEGY = """class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.prev_close = None

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        close_px = bar["prev_close"]
        if close_px is None:
            return
        pos = self.broker.position(symbol)
        if self.prev_close is None:
            self.prev_close = close_px
            return
        if pos == 0 and close_px > self.prev_close:
            self.broker.buy(symbol, qty=1)
        elif pos > 0 and close_px < self.prev_close:
            self.broker.sell(symbol, qty=pos)
        self.prev_close = close_px
"""


def run_smoke(symbol: str = "ES", interval: str = "1d", start: str = "2024-01-01", end: str = "2024-06-01") -> dict:
    with tempfile.TemporaryDirectory(prefix="finny-futures-smoke-") as tmp:
        root = Path(tmp)
        algo_dir = root / "algo"
        algo_dir.mkdir(parents=True, exist_ok=True)
        result = extract(symbol=symbol, interval=interval, start=start, end=end, algo_dir=str(algo_dir))
        if not result.parquet_path:
            raise RuntimeError(f"extract failed: {result.digest}")
        csv_path = root / "input.csv"
        if result.parquet_path.endswith(".parquet"):
            pd.read_parquet(result.parquet_path).to_csv(csv_path, index=False)
        else:
            pd.read_csv(result.parquet_path).to_csv(csv_path, index=False)

        config = {
            "symbol": symbol,
            "asset_class": "future",
            "execution": {
                "initial_margin_pct": 0.05,
                "maintenance_margin_pct": 0.04,
                "commission_per_contract": 2.25,
            },
        }
        config_path = root / "config.json"
        strategy_path = root / "strategy.py"
        out_dir = root / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config))
        strategy_path.write_text(STRATEGY)

        cmd = [
            sys.executable,
            "-m",
            "engine_v2.cli",
            "--csv",
            str(csv_path),
            "--config",
            str(config_path),
            "--interval",
            interval,
            "--capital",
            "100000",
            "--out",
            str(out_dir),
            "--mode",
            "v1_compat",
            "--strategy",
            str(strategy_path),
        ]
        env = dict(os.environ)
        repo_root = str(Path(__file__).resolve().parents[2])
        env["PYTHONPATH"] = repo_root if not env.get("PYTHONPATH") else f"{repo_root}{os.pathsep}{env['PYTHONPATH']}"
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
        return {
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "extract_digest": result.digest,
            "artifact_dir": str(out_dir),
        }


if __name__ == "__main__":
    print(json.dumps(run_smoke(), indent=2))
