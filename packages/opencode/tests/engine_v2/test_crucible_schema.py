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
    walk_forward = S.WalkForwardSummary(
        n_folds=5,
        is_sharpe_mean=-0.5,
        oos_sharpe_mean=-0.2,
        oos_decay=None,
        is_to_oos_sharpe_change=0.3,
        flag_threshold=0.5,
        flagged=True,
        deflated_sharpe=0.0,
        probabilistic_sharpe=0.0,
        stitched_oos_return=-0.01,
        stitched_oos_sharpe=-0.2,
        stitched_oos_trades=5,
        stitched_oos_bars=100,
        stitched_oos_coverage=1.0,
        ruined_folds=0,
        multiple_testing_trials=1,
        folds=[],
        flag_reasons=["nonpositive_is_sharpe"],
    )

    assert S.SCHEMA_VERSION == "3.5.0"
    assert nav.mark_to_market_nav == 10100.0
    assert costs.total_costs == 12.5
    assert profile.product_label == "Crucible 2.0"
    assert outcome.status == "pass"
    assert walk_forward.oos_decay is None
    assert walk_forward.flag_reasons == ["nonpositive_is_sharpe"]
