import yfinance as yf
import pandas as pd
import statistics
import math
from datetime import datetime, timedelta

# --- Strategy Class (Provided) ---
class Strategy:
    """
    PLTR Earnings Volatility Strategy
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
        self.stop_loss_pct = 0.08
        self.take_profit_pct = 0.15

        # Trade State
        self.entry_price = 0.0
        self.highest_price = 0.0
        self.post_earnings_open = None
        self.earnings_bar_index = -1

    def on_tick(self, bar: dict) -> str:
        # 1. Data Collection
        self.prices.append(bar["open"])
        self.highs.append(bar["high"])
        self.lows.append(bar["low"])
        self.closes.append(bar["close"])

        # Maintain buffer
        if len(self.prices) > 50:
            self.prices.pop(0)
            self.highs.pop(0)
            self.lows.pop(0)
            self.closes.pop(0)

        # 2. Earnings Detection
        current_price = bar["open"]

        if len(self.prices) < 5:
            return "HOLD"

        prev_close = self.closes[-2] if len(self.closes) >= 2 else self.prices[-2]
        gap_pct = (current_price - prev_close) / prev_close
        
        # logic not in original strategy but helpful for long backtests to avoid stale earnings signals
        # However, sticking strictly to provided code:
        
        if abs(gap_pct) > 0.05 and self.post_earnings_open is None:
            self.post_earnings_open = current_price
            self.earnings_bar_index = len(self.prices)
            return "HOLD"

        # 3. Position Management
        if self.position == 1:
            if current_price > self.highest_price:
                self.highest_price = current_price

            if current_price < self.entry_price * (1 - self.stop_loss_pct):
                self.position = 0
                return "SELL"

            if current_price > self.entry_price * (1 + self.take_profit_pct):
                self.position = 0
                return "SELL"

            if self.highest_price > self.entry_price * 1.05:
                if current_price < self.highest_price * 0.97:
                    self.position = 0
                    return "SELL"

            return "HOLD"

        # 4. Entry Logic
        elif self.position == 0:
            if self.post_earnings_open is None:
                return "HOLD"

            bars_since_open = len(self.prices) - self.earnings_bar_index
            
            # Simple expiry for earnings signal to avoid trading on old news
            # Assuming 1 week expiry (approx 130 bars of 15m)
            if bars_since_open > 130: 
                self.post_earnings_open = None
                return "HOLD"

            if bars_since_open < 3:
                return "HOLD"

            if self.post_earnings_open < prev_close:  # Gap Down
                if current_price > self.post_earnings_open * 1.01:
                    self.position = 1
                    self.entry_price = current_price
                    self.highest_price = current_price
                    return "BUY"

            elif self.post_earnings_open > prev_close:  # Gap Up
                # Handle case where highs buffer might be small initially
                recent_highs = self.highs[-3:]
                if not recent_highs: return "HOLD"
                
                recent_high = max(recent_highs)
                if current_price > recent_high:
                    self.position = 1
                    self.entry_price = current_price
                    self.highest_price = current_price
                    return "BUY"

        return "HOLD"

# --- Harness ---

def run_backtest():
    print("Fetching data...")
    # Fetch 15m data for PLTR
    # Note: yfinance 15m data is limited to last 60 days. 
    ticker = "PLTR"
    try:
        data = yf.download(ticker, interval="15m", period="60d", progress=False)
    except Exception as e:
        print(f"Error fetching data: {e}")
        return
    
    if data.empty:
        print("No data fetched. Try different parameters.")
        return

    # Flatten MultiIndex columns if present (yfinance update)
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.get_level_values(0)

    print(f"Data fetched: {len(data)} rows from {data.index[0]} to {data.index[-1]}")

    strategy = Strategy()
    
    initial_capital = 10000.0
    capital = initial_capital
    fee_rate = 0.00075 # 0.075%
    
    trades = []
    equity_curve = []
    
    position_size = 0
    entry_time = None
    
    print("Running strategy...")
    
    for index, row in data.iterrows():
        # Clean data keys
        bar = {
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "time": index
        }
        
        signal = strategy.on_tick(bar)
        
        current_price = bar["close"] # Executing at close as per instructions
        
        if signal == "BUY" and position_size == 0:
            # Buy
            entry_price = current_price
            
            # Maximize shares: 
            # Capital = Shares * Price * (1 + Rate)
            shares = capital / (entry_price * (1 + fee_rate))
            
            position_size = shares
            entry_time = index
            trade_entry_capital = capital
            
            # Record trade open
            trades.append({
                "type": "BUY",
                "time": index,
                "price": entry_price,
                "shares": shares,
                "fee": shares * entry_price * fee_rate
            })
            
            capital = 0 # All in
            
        elif signal == "SELL" and position_size > 0:
            # Sell
            exit_price = current_price
            sale_value = position_size * exit_price
            fee = sale_value * fee_rate
            
            capital = sale_value - fee
            
            trades.append({
                "type": "SELL",
                "time": index,
                "price": exit_price,
                "shares": position_size,
                "fee": fee,
                "pnl": capital - trade_entry_capital # Approximate PnL for this leg
            })
            
            position_size = 0
            entry_time = None
            
        # Update Equity Curve
        current_equity = capital
        if position_size > 0:
            current_equity = position_size * current_price
        
        equity_curve.append(current_equity)

    # Force close at end if open
    if position_size > 0:
        exit_price = data.iloc[-1]["Close"]
        sale_value = position_size * exit_price
        fee = sale_value * fee_rate
        capital = sale_value - fee
        trades.append({
            "type": "SELL_FORCE",
            "time": data.index[-1],
            "price": exit_price,
            "shares": position_size,
            "fee": fee
        })
        position_size = 0

    # --- Metrics ---
    final_equity = capital
    total_return_pct = ((final_equity - initial_capital) / initial_capital) * 100
    
    # Drawdown
    equity_series = pd.Series(equity_curve)
    running_max = equity_series.cummax()
    drawdown = (equity_series - running_max) / running_max
    max_drawdown_pct = drawdown.min() * 100
    
    # Trade Stats
    # A trade is a Buy + Sell pair
    completed_trades = [t for t in trades if t["type"] in ["SELL", "SELL_FORCE"]]
    num_trades = len(completed_trades)
    
    winning_trades = 0
    losing_trades = 0
    
    # Reconstruct round trips to get PnL per trade
    round_trips = []
    i = 0
    while i < len(trades):
        if trades[i]["type"] == "BUY":
            if i+1 < len(trades):
                buy = trades[i]
                sell = trades[i+1]
                
                invested = buy["shares"] * buy["price"]
                returned = sell["shares"] * sell["price"]
                fees = buy["fee"] + sell["fee"]
                pnl = returned - invested - fees
                
                round_trips.append(pnl)
                if pnl > 0: winning_trades += 1
                else: losing_trades += 1
                i += 2
            else:
                i += 1
        else:
            i += 1
            
    win_rate = (winning_trades / num_trades * 100) if num_trades > 0 else 0

    print("\n" + "="*30)
    print("RESULTS (PLTR 15m)")
    print("="*30)
    print(f"Data Period: {data.index[0]} to {data.index[-1]}")
    print(f"Starting Capital: ${initial_capital:,.2f}")
    print(f"Final Equity:     ${final_equity:,.2f}")
    print(f"Total Return:     {total_return_pct:.2f}%")
    print(f"Max Drawdown:     {max_drawdown_pct:.2f}%")
    print(f"Total Trades:     {num_trades}")
    print(f"Win Rate:         {win_rate:.2f}%")
    print("="*30)

if __name__ == "__main__":
    run_backtest()
