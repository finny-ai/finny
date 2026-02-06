from collections import deque
import statistics


class Strategy:
    def __init__(self):
        # Parameters for the buy-the-dip strategy
        self.price_history = deque(maxlen=50)  # Store the recent price history
        self.dip_threshold = 0.01  # 1% price drop to detect a dip
        self.rebound_threshold = 0.005  # 0.5% rebound to sell
        self.stop_loss_threshold = 0.02  # 2% stop-loss to limit losses
        self.last_buy_price = None

    def on_tick(self, bar: dict) -> str:
        """
        Handle a new market data tick (OHLCV bar).

        Parameters:
            bar (dict): A dictionary with keys 'symbol', 'open', 'high', 'low', 'close',
                        'volume', and 'timestamp'.

        Returns:
            str: The action to take - 'BUY', 'SELL', 'HOLD'.
        """
        current_price = bar["open"]  # Use the open price to avoid lookahead bias
        self.price_history.append(current_price)

        # Ensure we have sufficient data to analyze
        if len(self.price_history) < 2:
            return "HOLD"

        # Check if we're currently holding a position
        if self.last_buy_price is not None:
            # Check for rebound to sell
            if current_price >= self.last_buy_price * (1 + self.rebound_threshold):
                self.last_buy_price = None  # Reset the last buy price
                return "SELL"

            # Check for stop-loss condition
            if current_price <= self.last_buy_price * (1 - self.stop_loss_threshold):
                self.last_buy_price = None  # Reset the last buy price
                return "SELL"

        # Detect a dip (percentage drop from the recent high)
        recent_high = max(self.price_history)
        if current_price <= recent_high * (1 - self.dip_threshold):
            if self.last_buy_price is None:  # Only buy if not already holding
                self.last_buy_price = current_price
                return "BUY"

        return "HOLD"
