import statistics
import math

class Strategy:
    """
    PLTR Earnings Volatility Strategy
    ---------------------------------
    Designed for the 'Bleeding' context:
    1. Identifies the post-earnings Open price.
    2. If Gap DOWN > 5% (Bleeding continues): Waits for a 'V-Shape' reversal to buy the dip.
    3. If Gap UP > 5% (Surprise Turnaround): Buys the breakout if momentum sustains.
    4. Uses strict volatility-based stops to survive the 'crazy' moves.
    """
    def __init__(self):
        self.position = 0
        self.prices = []
        self.highs = []
        self.lows = []
        self.closes = []
        
        # Parameters
        self.lookback = 20
        self.vol_multiplier = 2.0
        self.stop_loss_pct = 0.08  # Wide 8% stop for earnings volatility
        self.take_profit_pct = 0.15 # Target 15% gain
        
        # Trade State
        self.entry_price = 0.0
        self.highest_price = 0.0
        self.post_earnings_open = None
        self.earnings_bar_index = -1

    def on_tick(self, bar: dict) -> str:
        # 1. Data Collection
        self.prices.append(bar['open'])
        self.highs.append(bar['high'])
        self.lows.append(bar['low'])
        self.closes.append(bar['close'])
        
        # Maintain buffer
        if len(self.prices) > 50:
            self.prices.pop(0)
            self.highs.pop(0)
            self.lows.pop(0)
            self.closes.pop(0)

        # 2. Earnings Detection (Sudden Volatility Spike)
        # We detect earnings reaction by a massive gap or range expansion
        current_price = bar['open']
        
        if len(self.prices) < 5:
            return "HOLD"

        prev_close = self.closes[-2] if len(self.closes) >= 2 else self.prices[-2]
        gap_pct = (current_price - prev_close) / prev_close
        
        # If we see a gap > 5% (up or down), we assume this is the earnings move
        if abs(gap_pct) > 0.05 and self.post_earnings_open is None:
            self.post_earnings_open = current_price
            self.earnings_bar_index = len(self.prices)
            # Don't trade the immediate open - wait for settlement
            return "HOLD"

        # 3. Position Management (Exit Logic)
        if self.position == 1:
            # Update trailing high
            if current_price > self.highest_price:
                self.highest_price = current_price
            
            # Stop Loss (Hard)
            if current_price < self.entry_price * (1 - self.stop_loss_pct):
                self.position = 0
                return "SELL"
            
            # Take Profit
            if current_price > self.entry_price * (1 + self.take_profit_pct):
                self.position = 0
                return "SELL"
                
            # Trailing Stop (activates after 5% gain)
            if self.highest_price > self.entry_price * 1.05:
                if current_price < self.highest_price * 0.97: # 3% trail
                    self.position = 0
                    return "SELL"
            
            return "HOLD"

        # 4. Entry Logic (Only if Flat)
        elif self.position == 0:
            # We need a defined earnings open to trade against
            if self.post_earnings_open is None:
                return "HOLD"
                
            # Wait at least 3 bars after open to let dust settle
            bars_since_open = len(self.prices) - self.earnings_bar_index
            if bars_since_open < 3:
                return "HOLD"

            # Scenario A: "The Bleeding Stops" (Gap Down -> Reversal)
            # If we gapped down, but price crosses back ABOVE the earnings open
            if self.post_earnings_open < prev_close: # Gap Down
                if current_price > self.post_earnings_open * 1.01: # 1% breakout above open
                    self.position = 1
                    self.entry_price = current_price
                    self.highest_price = current_price
                    return "BUY"

            # Scenario B: "Surprise Beat" (Gap Up -> Continuation)
            # If we gapped up, and price breaks the recent high (flag breakout)
            elif self.post_earnings_open > prev_close: # Gap Up
                recent_high = max(self.highs[-3:])
                if current_price > recent_high:
                    self.position = 1
                    self.entry_price = current_price
                    self.highest_price = current_price
                    return "BUY"

        return "HOLD"
