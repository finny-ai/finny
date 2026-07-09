import numpy as np

from engine_v2.robustness.decay import fold_sequence_slope, mann_kendall


def test_mann_kendall_detects_monotone_decrease():
    got = mann_kendall(np.linspace(2.0, -2.0, 60))
    assert got.trend == "decreasing"
    assert got.p_value is not None and got.p_value < 0.01


def test_mann_kendall_requires_history():
    got = mann_kendall(np.arange(10))
    assert got.trend == "insufficient"
    assert got.p_value is None


def test_fold_sequence_slope_requires_three_folds():
    assert fold_sequence_slope([1.0, 0.9]) is None
    got = fold_sequence_slope([1.0, 0.7, 0.4])
    assert got is not None
    assert got.slope < 0
