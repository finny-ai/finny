"""Commissions, funding (perps), borrow (shorts), dividends (equities)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class CostConfig:
    maker_fee_bps: float = 2.0
    taker_fee_bps: float = 7.0
    funding_rate_bps_per_interval: float = 0.0     # 0 = no perp funding
    funding_interval_hours: float = 8.0
    short_borrow_rate_annual: float = 0.0          # e.g. 0.02 = 2% annualized


def commission(notional: float, is_maker: bool, cfg: CostConfig) -> float:
    bps = cfg.maker_fee_bps if is_maker else cfg.taker_fee_bps
    return abs(notional) * (bps / 10_000.0)


def funding_charge(notional: float, cfg: CostConfig) -> float:
    """Per-funding-interval funding. Returns the absolute charge; caller
    decides the sign based on position direction."""
    return abs(notional) * (cfg.funding_rate_bps_per_interval / 10_000.0)


def borrow_charge_per_bar(notional: float, cfg: CostConfig, bars_per_year: float) -> float:
    if cfg.short_borrow_rate_annual <= 0 or bars_per_year <= 0:
        return 0.0
    return notional * cfg.short_borrow_rate_annual / bars_per_year
