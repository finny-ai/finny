from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.report import schema as S


def test_crucible_rollout_schema_blocks_are_serializable():
    nav = S.NavSummary(
        mark_to_market_nav=10100.0,
        liquidation_nav=9900.0,
        explanation="mtm",
    )
    costs = S.CostAttributionSummary(
        total_costs=12.5,
        fees=10.0,
        funding=2.5,
        borrow=0.0,
        cost_as_pct_starting_equity=0.00125,
        explanation="costs",
    )
    profile = S.ProfileIdentity(
        product_label="Crucible 2.0",
        profile_id="engine:seed:symbol:interval",
        strategy_hash="strategy",
        config_hash="config",
        data_hash="data",
        explanation="profile",
    )
    outcome = S.SensitivityOutcome(
        name="Monte Carlo",
        status="pass",
        value=0.5,
        explanation="mc",
    )

    assert S.SCHEMA_VERSION == "3.2.0"
    assert nav.mark_to_market_nav == 10100.0
    assert costs.total_costs == 12.5
    assert profile.product_label == "Crucible 2.0"
    assert outcome.status == "pass"
