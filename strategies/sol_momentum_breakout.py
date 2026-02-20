import math
from collections import deque

class Strategy:
    def __init__(self):
        # Strategy parameters
        self.fast_period = 10
        self.slow_period = 50
        self.rsi_period = 14
        
        self.take_profit_pct = 0.025  # 2.5%
        self.stop_loss_pct = 0.010    # 1.0%
        
        # State variables
        self.prices = deque(maxlen=100)
        self.gains = deque(maxlen=self.rsi_period)
        self.losses = deque(maxlen=self.rsi_period)
        self.last_price = None
        
        # Position tracking
        self.in_position = False
        self.entry_price = 0.0

    def calculate_sma(self, period):
        if len(self.prices) < period:
            return None
        prices_list = list(self.prices)[-period:]
        return sum(prices_list) / period

    def calculate_sma_prev(self, period):
        if len(self.prices) < period + 1:
            return None
        prices_list = list(self.prices)[-(period+1):-1]
        return sum(prices_list) / period

    def calculate_rsi(self):
        if len(self.gains) < self.rsi_period:
            return None
        
        avg_gain = sum(self.gains) / self.rsi_period
        avg_loss = sum(self.losses) / self.rsi_period
        
        if avg_loss == 0:
            return 100
            
        rs = avg_gain / avg_loss
        return 100 - (100 / (1 + rs))

    def on_tick(self, bar: dict) -> str:
        current_price = bar["open"]  # Avoid lookahead bias
        
        # Update price history and RSI components
        if self.last_price is not None:
            change = current_price - self.last_price
            if change > 0:
                self.gains.append(change)
                self.losses.append(0)
            else:
                self.gains.append(0)
                self.losses.append(abs(change))
                
        self.prices.append(current_price)
        self.last_price = current_price
        
        # Not enough data yet
        if len(self.prices) < self.slow_period + 1 or len(self.gains) < self.rsi_period:
            return "HOLD"
            
        # Manage open position
        if self.in_position:
            profit_pct = (current_price - self.entry_price) / self.entry_price
            
            # Take Profit
            if profit_pct >= self.take_profit_pct:
                self.in_position = False
                return "SELL"
                
            # Stop Loss
            if profit_pct <= -self.stop_loss_pct:
                self.in_position = False
                return "SELL"
                
            return "HOLD"
            
        # Entry logic
        fast_ma = self.calculate_sma(self.fast_period)
        slow_ma = self.calculate_sma(self.slow_period)
        prev_fast_ma = self.calculate_sma_prev(self.fast_period)
        prev_slow_ma = self.calculate_sma_prev(self.slow_period)
        rsi = self.calculate_rsi()
        
        if fast_ma is None or slow_ma is None or prev_fast_ma is None or prev_slow_ma is None or rsi is None:
            return "HOLD"
            
        # Check for EMA Cross Up + RSI filter
        crossed_above = prev_fast_ma <= prev_slow_ma and fast_ma > slow_ma
        
        if crossed_above and 50 <= rsi <= 65:
            self.in_position = True
            self.entry_price = current_price
            return "BUY"
            
        return "HOLD"