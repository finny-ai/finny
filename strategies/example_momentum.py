"""
Example Momentum Strategy

A simple momentum-based strategy that:
- Buys when price momentum is positive (price above 10-period average)
- Sells when momentum turns negative

This is a reference implementation showing the Strategy interface.
"""


class Strategy:
    def __init__(self):
        self.position = 0  # 0 = flat, 1 = long
        self.prices = []
        self.lookback = 10

    def on_tick(self, bar: dict) -> str:
        """
        Process a market tick and return trading decision.

        Args:
            bar: Dict with keys: symbol, open, high, low, close, volume, timestamp

        Returns:
            "BUY", "SELL", or "HOLD"
        """
        # Use open price to avoid lookahead bias
        current_price = bar['open']
        self.prices.append(current_price)

        # Need enough data for the lookback
        if len(self.prices) < self.lookback:
            return "HOLD"

        # Keep memory bounded
        if len(self.prices) > self.lookback + 50:
            self.prices = self.prices[-(self.lookback + 50):]

        # Calculate simple moving average
        sma = sum(self.prices[-self.lookback:]) / self.lookback

        # Trading logic
        if current_price > sma * 1.01 and self.position == 0:
            # Price is 1% above SMA, go long
            self.position = 1
            return "BUY"

        elif current_price < sma * 0.99 and self.position == 1:
            # Price is 1% below SMA, exit
            self.position = 0
            return "SELL"

        return "HOLD"
