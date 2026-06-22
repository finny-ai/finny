"""Versioned execution profiles.

Profiles are intentionally pinned constants. Strategy config may override
individual execution values, but the selected profile identity remains explicit
and both default/effective values are reported.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass
from typing import Any, Dict


PROFILE_VERSION = "execution-profiles-v1"


@dataclass(frozen=True)
class ExecutionProfile:
    id: str
    version: str
    asset_class: str
    venue: str
    defaults: Dict[str, Any]
    stress: Dict[str, Dict[str, Any]]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


_COMMON_STRESS = {
    "zero_cost": {
        "maker_fee_bps": 0.0,
        "taker_fee_bps": 0.0,
        "commission_per_contract": 0.0,
        "option_per_contract_fee": 0.0,
        "slippage_bps": 0.0,
        "k_vol": 0.0,
        "spread_enabled": False,
    },
    # ATR is a named sensitivity only. Defaults keep k_atr pinned at zero
    # until a profile-specific calibration fixture exists.
    "atr_stress": {"k_atr": 0.5},
}


PINNED_PROFILES: Dict[str, ExecutionProfile] = {
    "liquid_us_equity_v1": ExecutionProfile(
        id="liquid_us_equity_v1",
        version=PROFILE_VERSION,
        asset_class="equity",
        venue="US_EQUITIES",
        defaults={
            "participation_pct": 0.10,
            "maker_fee_bps": 0.0,
            "taker_fee_bps": 0.35,
            "commission_per_contract": 0.0,
            "slippage_bps": 1.0,
            "k_atr": 0.0,
            "k_vol": 5.0,
            "spread_enabled": True,
            "spread_k": 0.5,
            "spread_lookback": 30,
            "short_borrow_rate_annual": 0.02,
        },
        stress={**_COMMON_STRESS, "wide_spread": {"slippage_bps": 5.0, "spread_k": 1.5}},
    ),
    "crypto_spot_v1": ExecutionProfile(
        id="crypto_spot_v1",
        version=PROFILE_VERSION,
        asset_class="crypto_spot",
        venue="CRYPTO_SPOT",
        defaults={
            "participation_pct": 0.05,
            "maker_fee_bps": 2.0,
            "taker_fee_bps": 7.0,
            "commission_per_contract": 0.0,
            "slippage_bps": 2.0,
            "k_atr": 0.0,
            "k_vol": 8.0,
            "spread_enabled": True,
            "spread_k": 0.75,
            "spread_lookback": 30,
        },
        stress={**_COMMON_STRESS, "liquidity_stress": {"slippage_bps": 12.0, "k_vol": 20.0}},
    ),
    "crypto_perp_v1": ExecutionProfile(
        id="crypto_perp_v1",
        version=PROFILE_VERSION,
        asset_class="crypto_perp",
        venue="CRYPTO_PERP",
        defaults={
            "participation_pct": 0.03,
            "maker_fee_bps": 1.5,
            "taker_fee_bps": 5.0,
            "commission_per_contract": 0.0,
            "slippage_bps": 3.0,
            "k_atr": 0.0,
            "k_vol": 10.0,
            "spread_enabled": True,
            "spread_k": 1.0,
            "spread_lookback": 30,
            "funding_rate_bps": 0.0,
            "funding_interval_hours": 8.0,
        },
        stress={**_COMMON_STRESS, "funding_stress": {"funding_rate_bps": 5.0}},
    ),
    "listed_future_v1": ExecutionProfile(
        id="listed_future_v1",
        version=PROFILE_VERSION,
        asset_class="future",
        venue="LISTED_FUTURES",
        defaults={
            "participation_pct": 0.05,
            "maker_fee_bps": 0.0,
            "taker_fee_bps": 0.0,
            "slippage_bps": 1.0,
            "k_atr": 0.0,
            "k_vol": 6.0,
            "spread_enabled": True,
            "spread_k": 0.5,
            "spread_lookback": 30,
        },
        stress={**_COMMON_STRESS, "roll_stress": {"slippage_bps": 6.0, "spread_k": 2.0}},
    ),
    "fx_v1": ExecutionProfile(
        id="fx_v1",
        version=PROFILE_VERSION,
        asset_class="fx",
        venue="FX_SPOT",
        defaults={
            "participation_pct": 0.10,
            "maker_fee_bps": 0.0,
            "taker_fee_bps": 0.5,
            "commission_per_contract": 0.0,
            "slippage_bps": 0.5,
            "k_atr": 0.0,
            "k_vol": 3.0,
            "spread_enabled": True,
            "spread_k": 0.35,
            "spread_lookback": 60,
        },
        stress={**_COMMON_STRESS, "weekend_gap": {"slippage_bps": 8.0, "spread_k": 3.0}},
    ),
    "experimental_options_v1": ExecutionProfile(
        id="experimental_options_v1",
        version=PROFILE_VERSION,
        asset_class="option",
        venue="OPRA",
        defaults={
            "participation_pct": 0.02,
            "maker_fee_bps": 0.0,
            "taker_fee_bps": 0.0,
            "option_per_contract_fee": 0.65,
            "slippage_bps": 10.0,
            "k_atr": 0.0,
            "k_vol": 20.0,
            "spread_enabled": True,
            "spread_k": 2.0,
            "spread_lookback": 30,
        },
        stress={**_COMMON_STRESS, "wide_market": {"slippage_bps": 40.0, "spread_k": 4.0}},
    ),
}


_DEFAULT_PROFILE_BY_ASSET_CLASS = {
    p.asset_class: p.id for p in PINNED_PROFILES.values()
}

_EXECUTION_META_KEYS = {"profile_id", "execution_profile", "scenario", "scenarios"}
_EXTRA_OVERRIDE_KEYS = {
    "max_leverage", "initial_margin_pct", "maintenance_margin_pct",
    "funding_rate_bps", "funding_interval_hours", "short_borrow_rate_annual",
    "commission_per_contract", "option_per_contract_fee",
}


def default_profile_id(asset_class: str) -> str:
    return _DEFAULT_PROFILE_BY_ASSET_CLASS.get(asset_class, "liquid_us_equity_v1")


def _resolve_profile(asset_class: str, execution_cfg: Dict[str, Any]) -> ExecutionProfile:
    requested = str(
        execution_cfg.get("profile_id")
        or execution_cfg.get("execution_profile")
        or default_profile_id(asset_class)
    )
    if requested not in PINNED_PROFILES:
        raise ValueError(f"Unknown execution profile {requested!r}")
    profile = PINNED_PROFILES[requested]
    if profile.asset_class != asset_class:
        raise ValueError(
            f"Execution profile {requested!r} is for {profile.asset_class}, not {asset_class}; "
            "profile identity cannot be changed by overrides."
        )
    return profile


def _apply_execution_overrides(
    execution_cfg: Dict[str, Any],
    defaults: Dict[str, Any],
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    effective = deepcopy(defaults)
    overrides: Dict[str, Any] = {}
    for key, value in execution_cfg.items():
        if key in _EXECUTION_META_KEYS:
            continue
        if key in defaults or key in _EXTRA_OVERRIDE_KEYS:
            effective[key] = value
            overrides[key] = value
    return effective, overrides


def _build_scenarios(profile: ExecutionProfile, effective: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    extra_stress = next(
        (v for k, v in profile.stress.items() if k not in {"zero_cost", "atr_stress"}),
        {},
    )
    return {
        "zero_cost": {**effective, **profile.stress.get("zero_cost", {})},
        "base": dict(effective),
        "stressed": {**effective, **profile.stress.get("atr_stress", {}), **extra_stress},
    }


def resolve_execution_profile(asset_class: str, execution_cfg: Dict[str, Any]) -> Dict[str, Any]:
    profile = _resolve_profile(asset_class, execution_cfg)
    defaults = deepcopy(profile.defaults)
    effective, overrides = _apply_execution_overrides(execution_cfg, defaults)
    return {
        "profile": profile.to_dict(),
        "profile_defaults": defaults,
        "effective": effective,
        "overrides": overrides,
        "scenarios": _build_scenarios(profile, effective),
    }
