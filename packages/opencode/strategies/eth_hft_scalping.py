from collections import deque
import statistics


class Strategy:
    def __init__(self):
        # Initialize price history for 20-period Bollinger Bands
        self.prices = deque(maxlen=20)
        self.in_position = False
        self.buy_price = None
        self.stop_loss_pct = 0.005  # 0.5% stop loss

    def on_tick(self, bar: dict) -> str:
        # Use close for calculations, but open for decisions to avoid lookahead
        self.prices.append(bar["close"])
        current_price = bar["open"]

        # Need at least 20 prices
        if len(self.prices) < 20:
            return "HOLD"

        # Calculate Bollinger Bands
        sma = statistics.mean(self.prices)
        std = statistics.stdev(self.prices)
        lower_band = sma - 2 * std
        upper_band = sma + 2 * std

        if not self.in_position:
            # Buy when price touches or goes below lower band
            if current_price <= lower_band:
                self.in_position = True
                self.buy_price = current_price
                return "BUY"
        else:
            # Sell when price touches or goes above upper band, or stop loss
            if current_price >= upper_band or current_price <= self.buy_price * (
                1 - self.stop_loss_pct
            ):
                self.in_position = False
                self.buy_price = None
                return "SELL"

        return "HOLD"
