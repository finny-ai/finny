from collections import deque
import statistics


class Strategy:
    def __init__(self):
        # Position tracking (0 = flat, 1 = long)
        self.position = 0

        # Price history with bounded memory for indicators
        self.prices = deque(maxlen=20)  # For Bollinger Bands
        self.entry_price = None

    def calculate_bollinger_bands(self):
        mean = statistics.mean(self.prices)
        std_dev = statistics.stdev(self.prices)
        upper_band = mean + (2 * std_dev)
        lower_band = mean - (2 * std_dev)
        return lower_band, mean, upper_band

    def on_tick(self, bar: dict) -> str:
        price = bar["open"]  # Use the open price for decisions (avoids bias)
        self.prices.append(price)

        # Wait for enough data to calculate indicators
        if len(self.prices) < 20:
            return "HOLD"

        lower_band, middle_band, upper_band = self.calculate_bollinger_bands()

        # Entry Condition: Buy if price touches the lower Bollinger Band
        if price <= lower_band and self.position == 0:
            self.position = 1
            self.entry_price = price
            return "BUY"

        # Exit Condition: Dynamic trailing stop with upper band or 12% profit target
        if self.position == 1:
            profit_target = self.entry_price * 1.12
            stop_loss = middle_band  # Dynamic stop-loss level

            if price >= profit_target or price >= upper_band:
                self.position = 0
                self.entry_price = None
                return "SELL"

            if price < stop_loss:
                self.position = 0
                self.entry_price = None
                return "SELL"

        return "HOLD"
