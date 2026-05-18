# Data Extractor Subagent — TUI Workflow

## How it works visually

When any primary agent (Build, Research, Chat) needs historical market data,
it spawns a `data_extractor` subagent via the `task` tool. Here's what you
see in the TUI at each step.

---

### 1. User sends a message that needs data

```
You: Build me a BTC mean reversion strategy using 1h bars from Jan to June 2024
```

### 2. Build agent spawns the data extractor

In the session view, you see the task tool call appear inline:

```
│ ⟳ data_extractor — Extract BTC/USD 1h data
│   ↳ finny_extract_data fetching BTC/USD...
```

The `│` prefix with spinner indicates a running subagent task. The second
line shows which tool the subagent is currently executing.

### 3. Extractor runs (10-60 seconds depending on date range)

During execution, the TUI shows progress:

```
│ ⟳ data_extractor — Extract BTC/USD 1h data
│   ↳ finny_extract_data extracting BTC/USD 1h 2024-01-01→2024-06-01...
```

Behind the scenes:
- Python subprocess starts
- Tries Binance first (crypto) — paginated REST API, up to 1000 bars/request
- Falls back to yfinance if Binance fails
- Picks the source with the most bars
- Runs quality analysis (gaps, OHLC violations, outliers)
- Writes parquet to `~/.local/share/finny/algos/<algo>/data/crypto/`
- Generates statistical digest

### 4. Extractor completes

The inline task collapses to a summary:

```
└ data_extractor · 1 tool call · 23s
```

Click on it to navigate to the child session and see the full extraction log.

### 5. Parent agent receives the digest

The Build agent gets a structured summary (NOT raw bars):

```
## Data Extraction: BTC/USD 1h
**Period:** 2024-01-01 → 2024-06-01
**Bars written:** 4,320
**Source:** binance (tried: binance: 4320 bars, yfinance: 4318 bars)
**File:** ~/.local/share/finny/algos/btc-meanrev-1h/data/crypto/BTC-USD_1h_2024-01-01_2024-06-01.parquet

### Price Summary
- Open: 42,283.50 → Close: 67,491.20
- Range: 38,501.00 – 73,750.00
- Median: 52,108.00 | P5: 40,200.00 | P95: 71,800.00

### Performance
- Total return: 59.62%
- Annualized volatility: 48.21%
- Max drawdown: -21.38%

### Volume
- Average: 28,450.00
- Total: 122,904,000.00

### Data Quality
- Coverage: 99.8%
- Gaps: 3 | OHLC violations: 0 | Outliers: 1
```

The agent uses this digest to inform its strategy design — indicator
thresholds, risk levels, entry/exit parameters — without hallucinating
from raw number overload.

### 6. Build agent continues with the strategy

With the data context, the Build agent proceeds to scaffold, validate,
save, and backtest the strategy as normal. The parquet file is available
in the algo's data/ folder for the backtest engine to use.

---

## Subagent footer

When you click into the data_extractor child session, the TUI footer shows:

```
┌─ Subagent (1 of 1) ─────────────────────────────┐
│ data_extractor · 1,250 tokens (8%) · $0.02       │
│ [↑ Parent]                                        │
└───────────────────────────────────────────────────┘
```

---

## Where data lands on disk

```
~/.local/share/finny/algos/
  btc-meanrev-1h/
    mission.md
    CURRENT
    data/
      crypto/
        BTC-USD_1h_2024-01-01_2024-06-01.parquet    ← written by extractor
      stock/
        (empty unless stocks are extracted)
      sec/
      news/
        headlines/
        body/
    v01/
      strategy.py
      backtest.json
      reasoning.md
```

---

## How to trigger it manually

From any agent mode, you can explicitly ask for data extraction:

**Build mode:**
```
You: Extract ETH/USD 4h data from March to December 2024 for my eth-swing algo
```

**Chat mode:**
```
You: Can you pull 1d SPY data for all of 2023 and tell me the stats?
```

**Research mode:**
```
You: I'm researching a SOL momentum strategy. Get me 15m data for the last 6 months.
```

The agent will spawn the data_extractor subagent, which calls
`finny_extract_data`, and the result flows back as a digest.

---

## Multiple symbols

The data extractor handles one symbol per `finny_extract_data` call. For
multi-symbol strategies, the parent agent spawns the subagent once and the
subagent calls the tool sequentially for each symbol, returning a combined
summary.

```
You: Build a pairs trading strategy for BTC and ETH using 1h data from 2024

→ data_extractor spawned
  → finny_extract_data(BTC/USD, 1h, 2024-01-01, 2024-12-31)
  → finny_extract_data(ETH/USD, 1h, 2024-01-01, 2024-12-31)
→ returns combined digest for both symbols
```

---

## Error handling

If extraction fails for a symbol, the digest reports it clearly:

```
### Sources Tried
- binance: failed (400 Client Error: Invalid symbol)
- yfinance: failed (network timeout after 30s)

No data could be extracted for FAKECOIN/USD.
```

The parent agent can then ask the user to verify the symbol or try a
different date range.
