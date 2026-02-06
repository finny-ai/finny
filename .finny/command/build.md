---
description: Generate a trading strategy from natural language
agent: quant
---

# Build Trading Strategy

Generate a trading strategy based on the user's description.

## Instructions

1. Parse the user's strategy description
2. Identify the core trading logic (momentum, mean reversion, breakout, etc.)
3. Determine the symbol/asset class if specified
4. Generate a valid Python strategy following the `Strategy` class interface
5. Save the strategy to the `strategies/` folder in the project root (strategies/latest.py)

## User Request

{{ args }}

## Steps

1. Analyze the strategy requirements
2. Choose appropriate indicators or signals
3. Define entry and exit conditions
4. Implement proper position tracking
5. Write clean, documented code
6. Save to the project's `strategies/latest.py` (use absolute path or find the strategies folder in the project root)

Remember:
- Use `bar['open']` for entries, NOT `bar['close']` (lookahead bias!)
- Always check `self.position` before generating signals
- Keep state management simple
- Return exactly "BUY", "SELL", or "HOLD"
