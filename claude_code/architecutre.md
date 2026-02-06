# Finny Architecture Guide

## v0.2.0 — Local Development Setup

---

## 1. Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    YOUR MACHINE (localhost)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────┐    /deploy     ┌─────────────────┐       │
│   │     FINNY       │───────────────►│   ALGOCLASH     │       │
│   │   (Terminal)    │  localhost     │   (Simulator)   │       │
│   │                 │                │                 │       │
│   │  OpenCode fork  │                │  Already built  │       │
│   └─────────────────┘                └─────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Both run locally. No cloud needed.

---

## 2. Directory Structure

### Finny (OpenCode Fork)

```
finny/
├── packages/
│   └── opencode/
│       └── src/
│           ├── agent/           # Keep
│           ├── cli/             # Keep
│           ├── config/          # Keep
│           ├── provider/        # Keep
│           ├── tool/
│           │   ├── shell.ts     # Keep
│           │   ├── file.ts      # Keep
│           │   └── deploy.ts    # NEW
│           └── ...
│
├── .opencode/
│   ├── agent/
│   │   └── quant.md            # NEW - Financial prompt
│   └── command/
│       ├── build.md            # NEW
│       ├── deploy.md           # NEW
│       └── research.md         # NEW
│
├── strategies/
│   └── latest.py               # Generated strategies
│
├── finny.json                  # Config
└── package.json
```

---

## 3. Quant Agent

**File: `.opencode/agent/quant.md`**

```markdown
---
name: quant
description: Financial strategy generator
model: claude-sonnet-4-20250514
temperature: 0.3
tools:
  - shell
  - file_read
  - file_write
---

You are Finny, a trading strategy developer.

# Strategy Format

\`\`\`python
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
\`\`\`

# Rules

1. NO LOOKAHEAD: Don't use bar['close'] for entry decisions
2. TRACK POSITION: Don't buy if already long
3. KEEP IT SIMPLE: Clear, readable code

# Data

\`\`\`bash
# Historical
python -c "import yfinance as yf; print(yf.download('AAPL', period='5d'))"

# Real-time
curl "https://api.financialdatasets.ai/prices/snapshot?ticker=AAPL"
\`\`\`

Save strategies to `strategies/latest.py`
```

---

## 4. Commands

### /build

**File: `.opencode/command/build.md`**

```markdown
---
name: build
description: Generate a trading strategy
---

Generate a strategy for: $DESCRIPTION

Requirements:
- Use Strategy class with on_tick()
- Return 'BUY', 'SELL', or 'HOLD'
- No lookahead bias
- Track position

Save to `strategies/latest.py`
```

### /deploy

**File: `.opencode/command/deploy.md`**

```markdown
---
name: deploy
description: Deploy to local AlgoClash
---

Deploy `strategies/latest.py` to AlgoClash:

1. Read the file
2. Validate (syntax, lookahead, security)
3. POST to http://localhost:8000/deploy
4. Show result
```

### /research

**File: `.opencode/command/research.md`**

```markdown
---
name: research
description: Research a stock
---

Research: $SYMBOL

\`\`\`bash
python -c "
import yfinance as yf
data = yf.download('$SYMBOL', period='1mo')
print(data.tail(10))
"
\`\`\`

Analyze the trend and suggest strategy ideas.
```

---

## 5. Strategy Validator (AST-Based)

**⚠️ Don't use regex!** A user could bypass with `c = 'close'; if bar[c] > 0:`.

Use Python's `ast` module for proper code analysis:

```python
# validator.py
import ast

class StrategyValidator(ast.NodeVisitor):
    def __init__(self):
        self.errors = []
        self.has_strategy_class = False
        self.has_on_tick = False
        self.in_on_tick = False
    
    def visit_ClassDef(self, node):
        if node.name == 'Strategy':
            self.has_strategy_class = True
        self.generic_visit(node)
    
    def visit_FunctionDef(self, node):
        if node.name == 'on_tick':
            self.has_on_tick = True
            self.in_on_tick = True
            self.generic_visit(node)
            self.in_on_tick = False
        else:
            self.generic_visit(node)
    
    def visit_Import(self, node):
        forbidden = ['os', 'subprocess', 'sys', 'socket', 'requests']
        for alias in node.names:
            if alias.name in forbidden:
                self.errors.append(f"Security: import '{alias.name}' is forbidden")
        self.generic_visit(node)
    
    def visit_ImportFrom(self, node):
        forbidden = ['os', 'subprocess', 'sys', 'socket']
        if node.module in forbidden:
            self.errors.append(f"Security: import from '{node.module}' is forbidden")
        self.generic_visit(node)
    
    def visit_Subscript(self, node):
        # Detect bar['close'] access inside on_tick
        if self.in_on_tick:
            if (isinstance(node.value, ast.Name) and node.value.id == 'bar'
                and isinstance(node.slice, ast.Constant) and node.slice.value == 'close'):
                # Check if inside a conditional (if statement)
                # This is a warning - might be lookahead bias
                self.errors.append(
                    f"Warning: bar['close'] used in on_tick - potential lookahead bias. "
                    f"Use previous bar's close or bar['open'] instead."
                )
        self.generic_visit(node)
    
    def visit_Call(self, node):
        # Block dangerous functions
        if isinstance(node.func, ast.Name):
            if node.func.id in ['exec', 'eval', 'compile', '__import__']:
                self.errors.append(f"Security: '{node.func.id}()' is forbidden")
        self.generic_visit(node)


def validate_strategy(code: str) -> tuple[bool, list[str]]:
    """
    Validate strategy code using AST analysis.
    Returns (is_valid, list_of_errors)
    """
    errors = []
    
    # 1. Parse the code
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return False, [f"Syntax error on line {e.lineno}: {e.msg}"]
    
    # 2. Run AST visitor
    validator = StrategyValidator()
    validator.visit(tree)
    errors.extend(validator.errors)
    
    # 3. Check required structure
    if not validator.has_strategy_class:
        errors.append("Missing 'class Strategy'")
    if not validator.has_on_tick:
        errors.append("Missing 'def on_tick(self, bar)' method")
    
    return len(errors) == 0, errors


# Usage
if __name__ == "__main__":
    code = '''
class Strategy:
    def __init__(self):
        self.position = 0
    
    def on_tick(self, bar):
        if bar['close'] > bar['open']:  # This will trigger warning
            return 'BUY'
        return 'HOLD'
'''
    valid, errors = validate_strategy(code)
    print(f"Valid: {valid}")
    for e in errors:
        print(f"  - {e}")
```

**What it catches:**
- ✅ Syntax errors (with line numbers)
- ✅ Forbidden imports (`os`, `subprocess`, etc.)
- ✅ Dangerous functions (`exec`, `eval`)
- ✅ Missing `class Strategy`
- ✅ Missing `on_tick` method
- ⚠️ `bar['close']` in `on_tick` (lookahead warning)

---

## 6. Configuration

**File: `finny.json`**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "default": "quant"
  },
  "algoclash": {
    "url": "http://localhost:8000"
  }
}
```

---

## 7. Data Flow

```
User: /build momentum strategy for AAPL
                │
                ▼
        ┌───────────────┐
        │  Quant Agent  │
        │  (LLM)        │
        └───────┬───────┘
                │
                ▼
        strategies/latest.py
                │
User: /deploy   │
                ▼
        ┌───────────────┐
        │  Validator    │
        └───────┬───────┘
                │
        ┌───────┴───────┐
        ▼               ▼
    ❌ Errors       ✅ Valid
    Show & fix      POST to AlgoClash
                        │
                        ▼
                AlgoClash runs it
                (paper trading)
```

---

## 8. Setup Steps

### 1. Fork OpenCode

```bash
# On GitHub: Fork sst/opencode to finny-ai/finny
# Then clone:
git clone https://github.com/finny-ai/finny.git
cd finny
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Add Finny Config

```bash
# Create directories
mkdir -p .opencode/agent
mkdir -p .opencode/command
mkdir strategies

# Create files (copy from above)
# - .opencode/agent/quant.md
# - .opencode/command/build.md
# - .opencode/command/deploy.md
# - .opencode/command/research.md
# - finny.json
```

### 4. Run Finny

```bash
bun run dev
# or
npm run dev
```

### 5. Test

```
> /build simple moving average crossover for AAPL
> /deploy
```

---

## 9. Connecting to AlgoClash

AlgoClash runs on `localhost:8000` — no auth needed (Phase 1).

```bash
# Start AlgoClash (separate terminal)
cd algoclash
python main.py
# Running on http://localhost:8000
```

### Schema Endpoint (Recommended)

**Problem:** Finny might hallucinate features AlgoClash doesn't have (e.g., "use RSI" when AlgoClash doesn't calculate RSI).

**Fix:** Add a `/schema` endpoint to AlgoClash:

```bash
GET http://localhost:8000/schema

# Response
{
  "available_fields": ["open", "high", "low", "close", "volume", "timestamp"],
  "symbol": "AAPL",
  "timeframe": "10m",
  "indicators": []  # Empty for now, add later: ["rsi", "sma", "ema"]
}
```

**Finny startup flow:**
1. Finny starts
2. Polls `localhost:8000/schema`
3. Injects available fields into `quant.md` prompt
4. LLM knows exactly what data is available

This prevents strategies that reference non-existent data.

### Deploy Endpoint

```bash
POST http://localhost:8000/deploy
Content-Type: application/json

{
  "name": "my_strategy",
  "code": "class Strategy:..."
}

# Response
{
  "success": true,
  "strategy_id": "abc123"
}
```

### Check Status (if available)

```bash
GET http://localhost:8000/status/abc123

# AlgoClash tracks P&L, positions, trades internally
```

---

## 10. Phase 1 Checklist

- [ ] Fork sst/opencode
- [ ] Clone locally
- [ ] Create `.opencode/agent/quant.md`
- [ ] Create `/build` command
- [ ] Create `/deploy` command  
- [ ] Create `/research` command
- [ ] Add AST-based validator (`validator.py`)
- [ ] (Optional) Add `/schema` endpoint to AlgoClash
- [ ] Test with local AlgoClash
- [ ] Document setup
- [ ] Tag v0.2.0

---

## 11. What's NOT in Phase 1

- ❌ Cloud deployment
- ❌ Dashboard/frontend
- ❌ Leaderboards
- ❌ User accounts
- ❌ Real money trading
- ❌ State persistence (state resets on restart)

All of that is Phase 2+. Keep it simple for now.

---

## 12. Notes

**Stateless Strategies (Phase 1):**
```python
class Strategy:
    def __init__(self):
        self.position = 0      # Lost on restart!
        self.history = []      # Lost on restart!
```
If AlgoClash restarts, all strategy state resets. Accept this for Phase 1. Phase 2 can add `get_state()`/`set_state()` for persistence.

**AST Validator:** Always use `ast` module, never regex. Regex can be bypassed with tricks like `c='close'; bar[c]`.

**Schema Endpoint:** Consider `GET /schema` so Finny knows what fields AlgoClash provides. Prevents LLM hallucinations.

---

## 13. Next Steps After v0.2.0

1. Use it locally, find bugs
2. Improve validator (more lookahead patterns)
3. Add `/schema` endpoint if not done
4. Better error messages
5. Then consider Phase 2 (cloud)