"""
Technical Indicators Module

Provides functions for calculating common technical indicators used in trading strategies.
"""

from typing import List, Dict, Optional
import math


def calculate_rsi(closes: List[float], period: int = 14) -> Dict:
    """
    Calculate Relative Strength Index (RSI).

    RSI measures the magnitude of recent price changes to evaluate
    overbought or oversold conditions.

    Args:
        closes: List of closing prices
        period: RSI period (default 14)

    Returns:
        dict with 'rsi' (current value), 'values' (full series), and metadata
    """
    if len(closes) < period + 1:
        return {
            "rsi": None,
            "values": [],
            "period": period,
            "error": f"Insufficient data: need {period + 1} prices, got {len(closes)}"
        }

    # Calculate price changes
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]

    # Separate gains and losses
    gains = [max(0, c) for c in changes]
    losses = [abs(min(0, c)) for c in changes]

    rsi_values = []

    # Initial average gain/loss (SMA)
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    # First RSI value
    if avg_loss == 0:
        rsi_values.append(100.0)
    else:
        rs = avg_gain / avg_loss
        rsi_values.append(100 - (100 / (1 + rs)))

    # Calculate subsequent RSI values using EMA
    for i in range(period, len(changes)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        if avg_loss == 0:
            rsi_values.append(100.0)
        else:
            rs = avg_gain / avg_loss
            rsi_values.append(100 - (100 / (1 + rs)))

    current_rsi = rsi_values[-1] if rsi_values else None

    # Determine signal
    signal = "neutral"
    if current_rsi is not None:
        if current_rsi >= 70:
            signal = "overbought"
        elif current_rsi <= 30:
            signal = "oversold"

    return {
        "rsi": round(current_rsi, 2) if current_rsi is not None else None,
        "values": [round(v, 2) for v in rsi_values[-50:]],  # Last 50 values
        "period": period,
        "signal": signal
    }


def calculate_macd(closes: List[float], fast: int = 12, slow: int = 26, signal: int = 9) -> Dict:
    """
    Calculate MACD (Moving Average Convergence Divergence).

    MACD shows the relationship between two moving averages and is used
    to identify trend direction and potential reversals.

    Args:
        closes: List of closing prices
        fast: Fast EMA period (default 12)
        slow: Slow EMA period (default 26)
        signal: Signal line period (default 9)

    Returns:
        dict with 'macd', 'signal', 'histogram', and metadata
    """
    min_required = slow + signal
    if len(closes) < min_required:
        return {
            "macd": None,
            "signal": None,
            "histogram": None,
            "values": [],
            "error": f"Insufficient data: need {min_required} prices, got {len(closes)}"
        }

    def ema(data: List[float], period: int) -> List[float]:
        """Calculate Exponential Moving Average."""
        multiplier = 2 / (period + 1)
        ema_values = [sum(data[:period]) / period]  # Start with SMA

        for i in range(period, len(data)):
            ema_values.append((data[i] * multiplier) + (ema_values[-1] * (1 - multiplier)))

        return ema_values

    # Calculate EMAs
    fast_ema = ema(closes, fast)
    slow_ema = ema(closes, slow)

    # Align arrays (slow_ema starts later)
    offset = slow - fast
    fast_ema_aligned = fast_ema[offset:]

    # Calculate MACD line
    macd_line = [f - s for f, s in zip(fast_ema_aligned, slow_ema)]

    # Calculate signal line
    signal_line = ema(macd_line, signal)

    # Align for histogram
    macd_for_hist = macd_line[signal - 1:]
    histogram = [m - s for m, s in zip(macd_for_hist, signal_line)]

    current_macd = macd_line[-1] if macd_line else None
    current_signal = signal_line[-1] if signal_line else None
    current_histogram = histogram[-1] if histogram else None

    # Determine trend signal
    trend = "neutral"
    if current_macd is not None and current_signal is not None:
        if current_macd > current_signal:
            trend = "bullish"
        elif current_macd < current_signal:
            trend = "bearish"

    # Check for crossover
    crossover = None
    if len(macd_for_hist) >= 2 and len(signal_line) >= 2:
        prev_diff = macd_for_hist[-2] - signal_line[-2]
        curr_diff = macd_for_hist[-1] - signal_line[-1]
        if prev_diff < 0 and curr_diff >= 0:
            crossover = "bullish"
        elif prev_diff > 0 and curr_diff <= 0:
            crossover = "bearish"

    return {
        "macd": round(current_macd, 4) if current_macd is not None else None,
        "signal": round(current_signal, 4) if current_signal is not None else None,
        "histogram": round(current_histogram, 4) if current_histogram is not None else None,
        "trend": trend,
        "crossover": crossover,
        "values": {
            "macd": [round(v, 4) for v in macd_line[-30:]],
            "signal": [round(v, 4) for v in signal_line[-30:]],
            "histogram": [round(v, 4) for v in histogram[-30:]]
        },
        "params": {"fast": fast, "slow": slow, "signal": signal}
    }


def calculate_bollinger(closes: List[float], period: int = 20, std_dev: float = 2.0) -> Dict:
    """
    Calculate Bollinger Bands.

    Bollinger Bands consist of a middle band (SMA) with upper and lower bands
    at a specified number of standard deviations.

    Args:
        closes: List of closing prices
        period: SMA period (default 20)
        std_dev: Number of standard deviations (default 2)

    Returns:
        dict with 'upper', 'middle', 'lower', 'bandwidth', and metadata
    """
    if len(closes) < period:
        return {
            "upper": None,
            "middle": None,
            "lower": None,
            "bandwidth": None,
            "error": f"Insufficient data: need {period} prices, got {len(closes)}"
        }

    upper_values = []
    middle_values = []
    lower_values = []
    bandwidth_values = []

    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1:i + 1]

        # Calculate SMA
        sma = sum(window) / period

        # Calculate standard deviation
        variance = sum((x - sma) ** 2 for x in window) / period
        std = math.sqrt(variance)

        # Calculate bands
        upper = sma + (std_dev * std)
        lower = sma - (std_dev * std)

        # Calculate bandwidth percentage
        bandwidth = ((upper - lower) / sma) * 100 if sma > 0 else 0

        upper_values.append(upper)
        middle_values.append(sma)
        lower_values.append(lower)
        bandwidth_values.append(bandwidth)

    current_price = closes[-1]
    current_upper = upper_values[-1] if upper_values else None
    current_middle = middle_values[-1] if middle_values else None
    current_lower = lower_values[-1] if lower_values else None
    current_bandwidth = bandwidth_values[-1] if bandwidth_values else None

    # Determine position relative to bands
    position = "middle"
    if current_upper and current_lower:
        if current_price >= current_upper:
            position = "above_upper"
        elif current_price <= current_lower:
            position = "below_lower"
        elif current_price > current_middle:
            position = "upper_half"
        else:
            position = "lower_half"

    # Calculate percent B (price position within bands)
    percent_b = None
    if current_upper and current_lower and current_upper != current_lower:
        percent_b = (current_price - current_lower) / (current_upper - current_lower)

    return {
        "upper": round(current_upper, 2) if current_upper is not None else None,
        "middle": round(current_middle, 2) if current_middle is not None else None,
        "lower": round(current_lower, 2) if current_lower is not None else None,
        "bandwidth": round(current_bandwidth, 2) if current_bandwidth is not None else None,
        "percent_b": round(percent_b, 4) if percent_b is not None else None,
        "position": position,
        "current_price": round(current_price, 2),
        "values": {
            "upper": [round(v, 2) for v in upper_values[-30:]],
            "middle": [round(v, 2) for v in middle_values[-30:]],
            "lower": [round(v, 2) for v in lower_values[-30:]]
        },
        "params": {"period": period, "std_dev": std_dev}
    }


def calculate_volatility(closes: List[float], period: int = 20) -> Dict:
    """
    Calculate historical volatility.

    Uses standard deviation of log returns, annualized.

    Args:
        closes: List of closing prices
        period: Lookback period (default 20)

    Returns:
        dict with volatility metrics
    """
    if len(closes) < period + 1:
        return {
            "volatility": None,
            "annualized": None,
            "error": f"Insufficient data: need {period + 1} prices, got {len(closes)}"
        }

    # Calculate log returns
    log_returns = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))]

    # Calculate rolling volatility
    volatility_values = []

    for i in range(period - 1, len(log_returns)):
        window = log_returns[i - period + 1:i + 1]

        mean = sum(window) / len(window)
        variance = sum((r - mean) ** 2 for r in window) / len(window)
        vol = math.sqrt(variance)

        volatility_values.append(vol)

    current_vol = volatility_values[-1] if volatility_values else None

    # Annualize (assuming daily data, 252 trading days)
    annualized = current_vol * math.sqrt(252) if current_vol else None

    # Classify volatility level
    level = "normal"
    if annualized:
        if annualized > 0.50:  # 50%
            level = "very_high"
        elif annualized > 0.30:  # 30%
            level = "high"
        elif annualized < 0.10:  # 10%
            level = "low"

    return {
        "volatility": round(current_vol, 6) if current_vol is not None else None,
        "annualized": round(annualized, 4) if annualized is not None else None,
        "annualized_percent": round(annualized * 100, 2) if annualized is not None else None,
        "level": level,
        "period": period,
        "values": [round(v, 6) for v in volatility_values[-30:]]
    }


def calculate_correlation(series_a: List[float], series_b: List[float], period: Optional[int] = None) -> Dict:
    """
    Calculate Pearson correlation coefficient between two price series.

    Args:
        series_a: First price series
        series_b: Second price series
        period: Optional lookback period (uses all data if not specified)

    Returns:
        dict with correlation coefficient and interpretation
    """
    # Align series lengths
    min_len = min(len(series_a), len(series_b))

    if min_len < 2:
        return {
            "correlation": None,
            "error": "Insufficient data: need at least 2 data points"
        }

    # Use specified period or all data
    if period and period < min_len:
        a = series_a[-period:]
        b = series_b[-period:]
    else:
        a = series_a[-min_len:]
        b = series_b[-min_len:]

    n = len(a)

    # Calculate means
    mean_a = sum(a) / n
    mean_b = sum(b) / n

    # Calculate correlation
    numerator = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n))

    sum_sq_a = sum((x - mean_a) ** 2 for x in a)
    sum_sq_b = sum((x - mean_b) ** 2 for x in b)

    denominator = math.sqrt(sum_sq_a * sum_sq_b)

    if denominator == 0:
        return {
            "correlation": None,
            "error": "Cannot calculate correlation: zero variance in data"
        }

    correlation = numerator / denominator

    # Interpret correlation
    interpretation = "no_correlation"
    if correlation >= 0.7:
        interpretation = "strong_positive"
    elif correlation >= 0.4:
        interpretation = "moderate_positive"
    elif correlation >= 0.1:
        interpretation = "weak_positive"
    elif correlation <= -0.7:
        interpretation = "strong_negative"
    elif correlation <= -0.4:
        interpretation = "moderate_negative"
    elif correlation <= -0.1:
        interpretation = "weak_negative"

    return {
        "correlation": round(correlation, 4),
        "interpretation": interpretation,
        "data_points": n,
        "period": period
    }


def calculate_sma(closes: List[float], period: int) -> Dict:
    """
    Calculate Simple Moving Average.

    Args:
        closes: List of closing prices
        period: SMA period

    Returns:
        dict with SMA values
    """
    if len(closes) < period:
        return {
            "sma": None,
            "values": [],
            "error": f"Insufficient data: need {period} prices, got {len(closes)}"
        }

    sma_values = []
    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1:i + 1]
        sma_values.append(sum(window) / period)

    return {
        "sma": round(sma_values[-1], 2) if sma_values else None,
        "values": [round(v, 2) for v in sma_values[-50:]],
        "period": period
    }


def calculate_ema(closes: List[float], period: int) -> Dict:
    """
    Calculate Exponential Moving Average.

    Args:
        closes: List of closing prices
        period: EMA period

    Returns:
        dict with EMA values
    """
    if len(closes) < period:
        return {
            "ema": None,
            "values": [],
            "error": f"Insufficient data: need {period} prices, got {len(closes)}"
        }

    multiplier = 2 / (period + 1)
    ema_values = [sum(closes[:period]) / period]  # Start with SMA

    for i in range(period, len(closes)):
        ema_values.append((closes[i] * multiplier) + (ema_values[-1] * (1 - multiplier)))

    return {
        "ema": round(ema_values[-1], 2) if ema_values else None,
        "values": [round(v, 2) for v in ema_values[-50:]],
        "period": period
    }
