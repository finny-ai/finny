from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.report.emit import _sanitize_json


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
