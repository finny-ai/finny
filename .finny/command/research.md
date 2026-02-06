---
description: Research market data for a symbol
subtask: true
---

# Research Market Data

Fetch and analyze market data for a given symbol using yfinance.

## Symbol

{{ args }}

## Data Fetch

Get recent price data:

!`python3 << 'EOF'
import yfinance as yf
import json
from datetime import datetime

symbol = "{{ args }}".strip().upper() or "AAPL"

try:
    ticker = yf.Ticker(symbol)

    # Get current price info
    info = ticker.info
    current_price = info.get('currentPrice') or info.get('regularMarketPrice')
    prev_close = info.get('previousClose')
    market_cap = info.get('marketCap')
    pe_ratio = info.get('trailingPE')
    volume = info.get('volume')

    print(f"\n=== {symbol} Market Data ===\n")
    print(f"Current Price: ${current_price:,.2f}" if current_price else "Current Price: N/A")
    print(f"Previous Close: ${prev_close:,.2f}" if prev_close else "Previous Close: N/A")
    if current_price and prev_close:
        change = ((current_price - prev_close) / prev_close) * 100
        print(f"Change: {change:+.2f}%")
    print(f"Volume: {volume:,}" if volume else "Volume: N/A")
    print(f"Market Cap: ${market_cap:,.0f}" if market_cap else "Market Cap: N/A")
    print(f"P/E Ratio: {pe_ratio:.2f}" if pe_ratio else "P/E Ratio: N/A")

    # Get recent history
    hist = ticker.history(period="5d", interval="1h")
    if not hist.empty:
        print(f"\n=== Recent Price History (5d, 1h) ===\n")
        print(f"High: ${hist['High'].max():.2f}")
        print(f"Low: ${hist['Low'].min():.2f}")
        print(f"Avg Volume: {hist['Volume'].mean():,.0f}")

        # Simple trend analysis
        first_close = hist['Close'].iloc[0]
        last_close = hist['Close'].iloc[-1]
        trend = ((last_close - first_close) / first_close) * 100
        print(f"\n5-Day Trend: {trend:+.2f}%")

        # Volatility (simple std dev)
        returns = hist['Close'].pct_change().dropna()
        volatility = returns.std() * 100
        print(f"Hourly Volatility: {volatility:.3f}%")

except Exception as e:
    print(f"Error fetching data for {symbol}: {e}")
    print("Make sure yfinance is installed: pip install yfinance")
EOF`

## Analysis Notes

Based on the data above:
- Identify the recent trend direction
- Note any unusual volume patterns
- Consider volatility for strategy parameters
- Look for support/resistance levels in high/low range

## Usage in Strategy

When building a strategy for this symbol:
- Adjust position sizing based on volatility
- Set appropriate stop-loss levels
- Consider the trend direction for bias
