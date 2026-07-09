import numpy as np
import pandas as pd

from engine_v2.metrics.consistency import ConsistencyInput, compute_consistency
from engine_v2.metrics import returns as M_returns


class Fold:
    def __init__(self, value):
        self.oos_sharpe = value


class WF:
    n_folds = 5
    folds = [Fold(1.0), Fold(1.1), Fold(0.9), Fold(1.2), Fold(1.0)]


def ts(days):
    return np.array([t.value for t in pd.date_range("2025-01-01", periods=days, freq="1D", tz="UTC")], dtype=np.int64)


def test_smooth_compounding_is_consistent():
    equity = 10000 * np.cumprod(np.full(400, 1.001))
    returns = M_returns.bar_returns(equity)
    got = compute_consistency(ConsistencyInput(equity, ts(equity.size), returns, 252, WF()))
    assert got["label"] == "consistent"
    assert got["confidence"] == "high"


def test_short_window_is_insufficient():
    equity = 10000 * np.cumprod(np.full(45, 1.001))
    returns = M_returns.bar_returns(equity)
    got = compute_consistency(ConsistencyInput(equity, ts(equity.size), returns, 252, None))
    assert got["label"] == "insufficient"
