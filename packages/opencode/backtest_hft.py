import pandas as pd
from strategies.buy_the_dip_hft import Strategy

def backtest(strategy, data, starting_capital=10000):
    capital = starting_capital
    position = 0
    equity_curve = []  # To track equity over time
    trades = []  # Record trades

    for _, row in data.iterrows():
        bar = {"open": row['open'], "high": row['high'], "low": row['low'], "close": row['close'], "volume": row['volume'], "timestamp": row['timestamp']}
        action = strategy.on_tick(bar)

        if action == "BUY":
            position = capital / bar['open']
            capital = 0
            trades.append((row['timestamp'], action, bar['open']))
        elif action == "SELL":
            capital = position * bar['open']
            position = 0
            trades.append((row['timestamp'], action, bar['open']))

        equity = capital + position * bar['open']
        equity_curve.append(equity)

    return equity_curve, trades

# Load the simulated HFT dataset
data = pd.read_csv('hft_crypto_data.csv')
strategy = Strategy()
equity_curve, trades = backtest(strategy, data)

print(f"Trades Executed: {len(trades)}")
for t in trades:
    print(f"Timestamp: {t[0]}, Action: {t[1]}, Price: {t[2]}")
print(f"Final Equity: {equity_curve[-1]}")
