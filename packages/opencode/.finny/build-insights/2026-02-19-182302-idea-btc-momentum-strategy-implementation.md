---
title: "BTC Momentum Strategy Implementation"
category: idea
priority: high
created: 2026-02-19T18:23:02.833Z
strategy: "btc_momentum"
---

# BTC Momentum Strategy Implementation

**Category:** 💡 idea | **Priority:** high | **Strategy:** btc_momentum

*Saved: 2026-02-19T18:23:02.833Z*

## Insight

Implemented a BTC Momentum Day Trading strategy combining MACD (trend), RSI (moderate strength), and Bollinger Bands (price position). Added a 1.5% stop loss to manage risk for a 'Moderate' profile. Entry is restricted to RSI between 50-70 to capture momentum while avoiding overbought traps.

## Code

```python
if self.position == 0:
    if macd_line > macd_sig and 50 < rsi < 70 and price > bb_mid:
        self.position = 1
        self.entry_price = price
        return "BUY"
```

---

*Saved by Finny Build Agent*