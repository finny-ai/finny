import pandas as pd
from strategies.buy_the_dip import Strategy

def backtest(strategy, data, starting_capital=10000):
    capital = starting_capital
    position = 0
    equity = starting_capital
    trades = []
    
    for _, row in data.iterrows():
        bar = {"open": row['open'], "high": row['high'], "low": row['low'], "close": row['close'], "volume": row['volume'], "timestamp": row['timestamp']}
        action = strategy.on_tick(bar)

        if action == "BUY":
            position = capital / bar['open']
            capital = 0
            trades.append((row['timestamp'], "BUY", bar['open']))
        elif action == "SELL":
            capital = position * bar['open']
            position = 0
            trades.append((row['timestamp'], "SELL", bar['open']))
        
        equity = capital + (position * bar['open'])
        
    return equity, trades

# Example data handling
data = pd.DataFrame([
    {"timestamp": 1, "open": 100, "high": 105, "low": 95, "close": 100, "volume": 10},
    {"timestamp": 2, "open": 101, "high": 106, "low": 96, "close": 101, "volume": 15},
    {"timestamp": 3, "open": 99, "high": 102, "low": 94, "close": 99, "volume": 20},
])

strategy = Strategy()
equity, trades = backtest(strategy, data)
print(f"Ending equity: {equity}")
print(f"Trades: {trades}")
