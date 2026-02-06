# Starter Files & Templates

Copy these templates to get started quickly.

---

## Strategy Template

The basic structure every strategy must follow:

```python
class Strategy:
    """
    Trading strategy template for Finny/AlgoClash.

    Requirements:
    - Must have `class Strategy`
    - Must have `on_tick(self, bar)` method
    - Must return 'BUY', 'SELL', or 'HOLD'
    - Must track position to avoid duplicate orders
    """

    def __init__(self):
        # Position: 0 = flat (no position), 1 = long
        self.position = 0

        # Add your state variables here
        # self.prices = []
        # self.entry_price = 0

    def on_tick(self, bar: dict) -> str:
        """
        Called on each price update.

        Args:
            bar: {
                'symbol': 'BTC',
                'open': 95000.0,      # Use this for decisions
                'high': 95500.0,
                'low': 94800.0,
                'close': 95200.0,     # DON'T use for entry decisions
                'volume': 1500000,
                'timestamp': '2026-02-01T10:00:00Z'
            }

        Returns:
            'BUY'  - Open a long position
            'SELL' - Close the position
            'HOLD' - Do nothing
        """

        # Your strategy logic here

        return 'HOLD'
```

---

## Command Template

Create custom commands in `.finny/command/`:

```markdown
---
description: Short description of what this command does
subtask: true  # Optional: run as subtask
agent: build   # Optional: use specific agent
---

# Command Name

Describe what this command should do.

## Instructions

1. Step one
2. Step two
3. Step three

## User Input

{{ args }}

## Output

Describe expected output format.
```

---

## Agent Template

Create custom agents in `.finny/agent/`:

```markdown
---
description: When to use this agent
model: claude-sonnet-4-20250514
temperature: 0.3
---

You are a specialized assistant for [purpose].

# Your Role

Describe the agent's role and expertise.

# Rules

1. Rule one
2. Rule two
3. Rule three

# Output Format

Describe expected output format.

# Examples

Show example interactions.
```

---

## Config Template

`finny.json` or `.finny/finny.json`:

```json
{
  "$schema": "https://finny.ai/config.json",
  "agent": {
    "build": {
      "model": "claude-sonnet-4-20250514",
      "temperature": 0.3
    },
    "research": {
      "model": "claude-sonnet-4-20250514"
    }
  },
  "default_agent": "build"
}
```

---

## Strategy Examples

### Minimal Strategy

```python
class Strategy:
    def __init__(self):
        self.position = 0

    def on_tick(self, bar: dict) -> str:
        return 'HOLD'
```

### With Indicator

```python
class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = []
        self.sma_period = 20

    def on_tick(self, bar: dict) -> str:
        self.prices.append(bar['open'])

        if len(self.prices) < self.sma_period:
            return 'HOLD'

        self.prices = self.prices[-self.sma_period:]
        sma = sum(self.prices) / self.sma_period

        if bar['open'] > sma and self.position == 0:
            self.position = 1
            return 'BUY'
        elif bar['open'] < sma and self.position == 1:
            self.position = 0
            return 'SELL'

        return 'HOLD'
```

### With Stop Loss

```python
class Strategy:
    def __init__(self):
        self.position = 0
        self.entry_price = 0
        self.stop_loss_pct = 0.03  # 3%

    def on_tick(self, bar: dict) -> str:
        price = bar['open']

        # Check stop loss
        if self.position == 1:
            if price < self.entry_price * (1 - self.stop_loss_pct):
                self.position = 0
                return 'SELL'

        # Entry logic (customize this)
        if self.position == 0:
            self.position = 1
            self.entry_price = price
            return 'BUY'

        return 'HOLD'
```

---

## File Structure

```
your-project/
├── .finny/
│   ├── finny.json          # Project config
│   ├── agent/
│   │   └── custom.md       # Custom agents
│   └── command/
│       └── custom.md       # Custom commands
├── strategies/
│   └── latest.py           # Generated strategies
└── ...
```

---

## Quick Start Commands

```bash
# Create config directory
mkdir -p .finny/command .finny/agent

# Create a basic config
echo '{"$schema": "https://finny.ai/config.json"}' > .finny/finny.json

# Create strategies folder
mkdir -p strategies

# Start Finny
finny
```
