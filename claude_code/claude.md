# CLAUDE.md - Instructions for AI Coding Assistants

> This file guides Claude Code (or similar AI assistants) when working on Finny.

## Project Overview

**Finny** is an OpenCode fork that generates trading strategies from natural language and deploys them to AlgoClash.

```
User: "Build RSI strategy"
  → Finny (LLM generates Python)
  → Validator (AST checks)
  → Deploy to AlgoClash (localhost:8000)
```

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (Finny core), Python (strategies, validator)
- **Base:** Forked from [sst/opencode](https://github.com/sst/opencode)
- **LLM:** Claude, OpenAI, Gemini (via OpenCode's provider system)

## Project Structure

```
finny/
├── packages/
│   └── opencode/              # Core (inherited from OpenCode)
│       └── src/
│           ├── agent/         # Agent definitions
│           ├── cli/           # CLI commands
│           ├── config/        # Config loading
│           ├── provider/      # LLM providers
│           ├── session/       # Chat sessions
│           └── tool/          # Tools (shell, file, etc.)
│
├── .opencode/                 # OUR CUSTOMIZATIONS
│   ├── agent/
│   │   └── quant.md          # Financial agent prompt
│   └── command/
│       ├── build.md          # /build command
│       ├── deploy.md         # /deploy command
│       └── research.md       # /research command
│
├── strategies/               # Generated Python strategies
│   └── latest.py
│
├── validator.py              # AST-based strategy validator
├── finny.json               # Project config
└── idea.md                  # Vision doc (read this!)
```

## Key Files to Know

| File | Purpose |
|------|---------|
| `.opencode/agent/quant.md` | System prompt for the quant agent |
| `.opencode/command/*.md` | Custom slash commands |
| `validator.py` | AST-based code validation |
| `finny.json` | Config (AlgoClash URL, default agent) |
| `idea.md` | Project vision and decisions |
| `architecture.md` | Technical architecture |

## What We're Building (Phase 1)

### 1. Quant Agent (`.opencode/agent/quant.md`)

A specialized agent that:
- Understands trading terminology
- Generates Python strategies with `on_tick()` interface
- Avoids lookahead bias
- Knows to save to `strategies/latest.py`

### 2. Commands

| Command | File | What it does |
|---------|------|--------------|
| `/build` | `command/build.md` | Generate strategy from description |
| `/deploy` | `command/deploy.md` | POST to `localhost:8000/deploy` |
| `/research` | `command/research.md` | Fetch & analyze market data |

### 3. Validator (`validator.py`)

Python AST-based validator that checks:
- Syntax errors
- Lookahead bias (`bar['close']` in `on_tick`)
- Forbidden imports (`os`, `subprocess`, `eval`)
- Required structure (`class Strategy`, `def on_tick`)

## Strategy Format

All generated strategies MUST follow this format:

```python
class Strategy:
    def __init__(self):
        self.position = 0  # 0 = flat, 1 = long
    
    def on_tick(self, bar: dict) -> str:
        """
        bar = {
            'symbol': 'AAPL',
            'open': 150.0,
            'high': 152.0,
            'low': 149.0,
            'close': 151.0,
            'volume': 1000000,
            'timestamp': '2026-01-29T10:00:00Z'
        }
        
        Returns: 'BUY', 'SELL', or 'HOLD'
        """
        return 'HOLD'
```

## Critical Rules

### DO:
- Use AST (`import ast`) for code validation, never regex
- Save strategies to `strategies/latest.py`
- Deploy to `http://localhost:8000/deploy`
- Track position state to avoid duplicate buys
- Use `bar['open']` for entry decisions (not `bar['close']`)

### DON'T:
- Use regex for code validation (can be bypassed)
- Use `bar['close']` for real-time decisions (lookahead bias)
- Import `os`, `subprocess`, `sys`, `socket` in strategies
- Use `exec()`, `eval()`, `__import__()` in strategies
- Assume state persists across AlgoClash restarts

## AlgoClash Integration

AlgoClash runs on `localhost:8000`. No auth needed.

### Deploy Endpoint

```bash
POST http://localhost:8000/deploy
Content-Type: application/json

{
  "name": "my_strategy",
  "code": "class Strategy:..."
}

# Response
{"success": true, "strategy_id": "abc123"}
```

### Schema Endpoint (Optional)

```bash
GET http://localhost:8000/schema

# Response
{"available_fields": ["open", "high", "low", "close", "volume"]}
```

## Common Tasks

### "Add a new command"
1. Create `.opencode/command/mycommand.md`
2. Follow existing command format (see `build.md`)

### "Improve the validator"
1. Edit `validator.py`
2. Add new `visit_*` methods to the AST visitor
3. Test with edge cases

### "Modify the quant agent"
1. Edit `.opencode/agent/quant.md`
2. Update the system prompt
3. Test with `/build` command

### "Add a new indicator"
1. Add calculation logic to strategy template in `quant.md`
2. Document available indicators

## Testing

```bash
# Run Finny
bun run dev

# Test commands
> /build simple moving average crossover
> /deploy
> /research AAPL
```

## Data Sources

- **Historical:** `yfinance` (Python library)
- **Real-time:** `financialdatasets.ai` (curl)
- **Backup:** Twelve Data

```bash
# Historical
python -c "import yfinance as yf; print(yf.download('AAPL', period='5d'))"

# Real-time
curl "https://api.financialdatasets.ai/prices/snapshot?ticker=AAPL"
```

## Questions?

Read these files:
1. `idea.md` - Vision and roadmap
2. `architecture.md` - Technical details
3. This file - Coding guidance