"""Interval parsing + bars-per-year. Ported from backtest.py:241."""

from __future__ import annotations

from typing import Tuple


def interval_to_rule_and_bars_per_year(interval: str) -> Tuple[str, float]:
    s = interval.strip().lower()
    if s.endswith("mins"):
        s = s[:-4] + "m"
    elif s.endswith("min"):
        s = s[:-3] + "m"
    if s.endswith("m"):
        n = int(s[:-1])
        return f"{n}min", (60.0 / n) * 24.0 * 365.0
    if s.endswith("h"):
        n = int(s[:-1])
        return f"{n}H", (24.0 / n) * 365.0
    if s.endswith("d"):
        n = int(s[:-1])
        return f"{n}D", 365.0 / n
    raise ValueError(f"Unsupported interval: {interval}")


def bars_per_day(interval: str) -> float:
    _, bpy = interval_to_rule_and_bars_per_year(interval)
    return bpy / 365.0
