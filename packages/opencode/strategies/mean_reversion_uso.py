"""
Mean-reversion strategy for USO using Bollinger Bands with RSI filter.

Buys when price touches lower Bollinger Band and RSI confirms oversold.
Sells when price reaches upper band or RSI confirms overbought.
Includes volatility filter and proper position sizing based on stop loss.
"""

from collections import deque


class Strategy:
    def __init__(self):
        """Initialize the mean-reversion strategy."""
        # Bollinger Bands parameters
        self.bollinger_period = 20
        self.bollinger_std = 2.0

        # RSI parameters
        self.rsi_period = 14
        self.rsi_oversold = 30
        self.rsi_overbought = 70

        # Risk management parameters
        self.volatility_threshold = 0.02
        self.max_risk_per_trade_percent = 1.0
        self.stop_loss_pct = 0.02
        self.take_profit_pct = 0.04

        # Price history for indicators
        self.prices = deque(maxlen=self.bollinger_period)

        # RSI calculation state - MUST be on self, not locals
        self.gains = deque(maxlen=self.rsi_period)
        self.losses = deque(maxlen=self.rsi_period)

        # Volatility calculation (returns)
        self.returns = deque(maxlen=20)

        # Trade tracking - use -1 to indicate no position (avoid [0,100] range)
        self.position = 0
        self.entry_price = -1.0
        self.stop_loss = -1.0
        self.take_profit = -1.0

    def _calculate_bollinger_bands(self):
        """
        Calculate Bollinger Bands using sample variance (N-1).

        Returns:
            tuple: (middle_band, upper_band, lower_band) or (None, None, None)
        """
        if len(self.prices) < self.bollinger_period:
            return None, None, None

        prices_list = list(self.prices)

        # Middle band is SMA
        middle_band = sum(prices_list) / len(prices_list)

        # Standard deviation using sample variance (N-1)
        squared_diffs = [(p - middle_band) ** 2 for p in prices_list]
        variance = sum(squared_diffs) / (len(prices_list) - 1)

        # Check for zero variance
        if variance <= 0:
            return None, None, None

        std_dev = variance**0.5

        # Bollinger Bands
        upper_band = middle_band + (self.bollinger_std * std_dev)
        lower_band = middle_band - (self.bollinger_std * std_dev)

        return middle_band, upper_band, lower_band

    def _calculate_rsi(self):
        """
        Calculate RSI indicator.

        Returns:
            float: RSI value (0-100) or None if insufficient data
        """
        if len(self.gains) < self.rsi_period or len(self.losses) < self.rsi_period:
            return None

        avg_gain = sum(self.gains) / len(self.gains)
        avg_loss = sum(self.losses) / len(self.losses)

        # Handle flat market case - return neutral RSI
        if avg_gain == 0 and avg_loss == 0:
            return 50.0

        # Prevent division by zero
        if avg_loss == 0:
            return 100.0

        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))

        return rsi

    def _calculate_volatility(self):
        """
        Calculate volatility as standard deviation of returns (mean-subtracted).

        Returns:
            float: Volatility or None if insufficient data
        """
        if len(self.returns) < 2:
            return None

        returns_list = list(self.returns)
        mean_return = sum(returns_list) / len(returns_list)

        # Standard deviation with mean subtraction (not RMS)
        squared_diffs = [(r - mean_return) ** 2 for r in returns_list]
        variance = sum(squared_diffs) / (len(returns_list) - 1)
        volatility = variance**0.5

        return volatility

    def on_tick(self, bar):
        """
        Process each bar and make trading decisions.

        Args:
            bar: OHLCV data with keys: timestamp, open, high, low, close, volume

        Returns:
            str: "BUY", "SELL", or "HOLD"
        """
        current_price = bar["open"]  # Use open for decisions to avoid lookahead bias

        # Update price history
        self.prices.append(current_price)

        # Calculate returns for volatility
        if len(self.prices) >= 2:
            prev_price = list(self.prices)[-2]
            if prev_price != 0:
                daily_return = (current_price - prev_price) / prev_price
                self.returns.append(daily_return)

        # Update RSI gains/losses - MUST persist on self
        if len(self.prices) >= 2:
            prev_price = list(self.prices)[-2]
            price_change = current_price - prev_price

            if price_change > 0:
                self.gains.append(price_change)
                self.losses.append(0.0)
            else:
                self.gains.append(0.0)
                self.losses.append(abs(price_change))

        # Wait for sufficient data
        if len(self.prices) < self.bollinger_period:
            return "HOLD"

        # Calculate indicators
        middle_band, upper_band, lower_band = self._calculate_bollinger_bands()
        rsi = self._calculate_rsi()
        volatility = self._calculate_volatility()

        if middle_band is None or rsi is None or volatility is None:
            return "HOLD"

        # Manage existing position
        if self.position == 1 and self.entry_price > 0:
            # Check stop loss
            if current_price <= self.stop_loss:
                self.position = 0
                self.entry_price = -1.0
                return "SELL"

            # Check take profit
            if current_price >= self.take_profit:
                self.position = 0
                self.entry_price = -1.0
                return "SELL"

            # Check exit conditions (upper band or overbought RSI)
            if current_price >= upper_band or rsi >= self.rsi_overbought:
                self.position = 0
                self.entry_price = -1.0
                return "SELL"

        # Entry logic (only if no position)
        if self.position == 0:
            # Check volatility filter - only trade when volatility is below threshold
            if volatility > self.volatility_threshold:
                return "HOLD"

            # Mean reversion entry: price at lower band AND RSI oversold
            if current_price <= lower_band and rsi <= self.rsi_oversold:
                self.position = 1
                self.entry_price = current_price
                self.stop_loss = current_price * (1 - self.stop_loss_pct)
                self.take_profit = current_price * (1 + self.take_profit_pct)
                return "BUY"

        return "HOLD"
