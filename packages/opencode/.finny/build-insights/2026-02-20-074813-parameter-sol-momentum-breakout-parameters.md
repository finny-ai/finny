---
title: "SOL Momentum Breakout Parameters"
category: parameter
priority: high
created: 2026-02-20T07:48:13.989Z
strategy: "sol_momentum_breakout"
tags: ["crypto", "momentum", "solana", "risk-management"]
---

# SOL Momentum Breakout Parameters

**Category:** 🎛️ parameter | **Priority:** high | **Strategy:** sol_momentum_breakout | **Tags:** crypto, momentum, solana, risk-management

*Saved: 2026-02-20T07:48:13.989Z*

## Insight

For highly volatile crypto assets like Solana (SOL), aiming for ultra-small short-term gains (e.g. 0.1%) exposes strategies to significant drain from trading fees and slippage (~0.17% round trip). Instead, I've designed a Crypto Momentum Breakout strategy with a target of 2.5% profit per winning trade vs a tight 1.0% stop-loss. This produces a strong 1:2.5 risk-to-reward ratio. This approach relies on entering only when momentum is strongly confirmed: an EMA Golden Cross (fast EMA > slow EMA) combined with an RSI condition (RSI between 50 and 65) to avoid buying into overbought territory.

## Code

```python
self.take_profit_pct = 0.025  # 2.5%
self.stop_loss_pct = 0.010    # 1.0%
self.fast_period = 10
self.slow_period = 50
self.rsi_period = 14
```

---

*Saved by Finny Build Agent*