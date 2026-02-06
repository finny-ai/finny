from collections import deque
import math


class Strategy:
    def __init__(self):
        # State for tracking position and indicators
        self.prices = deque(maxlen=201)  # Store up to 201 closes for EMA calculations
        self.ema50_prev = None
        self.ema200_prev = None
        self.in_position = False

    def calculate_ema(self, prices, period):
        if len(prices) < period:
            return None
        # Initial SMA for the first period
        ema = sum(prices[:period]) / period
        multiplier = 2 / (period + 1)
        # Calculate EMA for remaining prices
        for price in prices[period:]:
            ema = (price * multiplier) + (ema * (1 - multiplier))
        return ema

    def on_tick(self, bar: dict) -> str:
        # Append current close price
        self.prices.append(bar["close"])

        # Need at least 201 prices for full EMA calculation
        if len(self.prices) < 201:
            return "HOLD"

        # Calculate current EMAs
        ema50 = self.calculate_ema(list(self.prices), 50)
        ema200 = self.calculate_ema(list(self.prices), 200)

        if ema50 is None or ema200 is None:
            return "HOLD"

        # Initialize previous EMAs if first time
        if self.ema50_prev is None:
            self.ema50_prev = ema50
            self.ema200_prev = ema200
            return "HOLD"

        # Check for Golden Cross (entry)
        if (
            not self.in_position
            and ema50 > ema200
            and self.ema50_prev <= self.ema200_prev
        ):
            self.in_position = True
            # Update previous values
            self.ema50_prev = ema50
            self.ema200_prev = ema200
            return "BUY"

        # Check for Death Cross (exit)
        elif (
            self.in_position and ema50 < ema200 and self.ema50_prev >= self.ema200_prev
        ):
            self.in_position = False
            # Update previous values
            self.ema50_prev = ema50
            self.ema200_prev = ema200
            return "SELL"

        # Update previous EMAs for next iteration
        self.ema50_prev = ema50
        self.ema200_prev = ema200
