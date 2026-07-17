from __future__ import annotations

import math
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.report.emit import _sanitize_json, _walk_forward_sensitivity_status


def test_sanitize_json_replaces_non_finite_values_and_records_paths():
    payload = {
        "trade": {"profit_factor": math.inf},
        "ratios": {"omega": -math.inf},
        "risk": {"skew": math.nan},
    }

    sanitized, found = _sanitize_json(payload)

    assert sanitized["trade"]["profit_factor"] is None
    assert sanitized["ratios"]["omega"] is None
    assert sanitized["risk"]["skew"] is None
    assert found == [
        {"path": "trade.profit_factor", "value": "inf"},
        {"path": "ratios.omega", "value": "-inf"},
        {"path": "risk.skew", "value": "nan"},
    ]


def _walk_forward(**overrides):
    values = {
        "flagged": False,
        "n_folds": 5,
        "oos_decay": 0.8,
        "stitched_oos_return": 0.05,
        "stitched_oos_sharpe": 0.9,
        "stitched_oos_coverage": 1.0,
        "ruined_folds": 0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_walk_forward_sensitivity_status_matches_absolute_and_retention_gates():
    assert _walk_forward_sensitivity_status(_walk_forward()) == "pass"
    assert _walk_forward_sensitivity_status(_walk_forward(oos_decay=0.6)) == "review"
    assert _walk_forward_sensitivity_status(_walk_forward(oos_decay=None)) == "review"
    assert _walk_forward_sensitivity_status(_walk_forward(stitched_oos_return=-0.01)) == "review"
    assert _walk_forward_sensitivity_status(_walk_forward(stitched_oos_sharpe=-0.1)) == "review"
    assert _walk_forward_sensitivity_status(_walk_forward(stitched_oos_coverage=0.9)) == "review"
    assert _walk_forward_sensitivity_status(_walk_forward(stitched_oos_coverage=None)) == "review"
    assert _walk_forward_sensitivity_status(_walk_forward(ruined_folds=1)) == "review"
    assert _walk_forward_sensitivity_status(_walk_forward(n_folds=1)) == "review"
