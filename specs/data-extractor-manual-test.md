# Data Extractor — Manual TUI Test Plan

Run these tests in the Finny TUI to verify the data extractor subagent works
end-to-end. Each test lists the **mode**, the **message to send**, what to
**observe** in the TUI, and what to **verify** on disk afterward.

Prerequisites:
- `bun run dev` from `packages/opencode/`
- An active algo (create one first if none exists)
- Internet connection (tests hit Binance / yfinance)

---

## Test 1 — Crypto extraction from Build mode

**Mode:** Build (Tab to switch)

**Send:**
```text
Build me a BTC mean reversion strategy using 1h bars from Jan to March 2024
```

**Observe in TUI:**
1. Build agent recognizes data is needed and spawns `data_extractor`:
   ```text
   │ ⟳ data_extractor — Extract BTC/USD 1h data
   │   ↳ finny_extract_data fetching BTC/USD...
   ```
2. Progress updates show source being tried (Binance first for crypto)
3. Task collapses to summary after 10-60s:
   ```text
   └ data_extractor · 1 tool call · XXs
   ```
4. Build agent receives the digest and continues with strategy design

**Verify on disk:**
```bash
ALGO=$(cat ~/.local/share/finny/active_algo 2>/dev/null || echo "check-your-algo-name")
ls -la ~/.local/share/finny/algos/$ALGO/data/crypto/

# Expected:
# BTC-USD_1h_2024-01-01_2024-03-01.parquet
```

```bash
# Inspect parquet content
PQ=$(ls ~/.local/share/finny/algos/$ALGO/data/crypto/BTC-USD_1h_*.parquet 2>/dev/null | head -1)
[ -z "$PQ" ] && echo "No parquet found" && exit 1
python3 -c "
import pandas as pd, sys
df = pd.read_parquet(sys.argv[1])
print(f'Rows: {len(df)}')
print(f'Columns: {list(df.columns)}')
print(f'Date range: {df.timestamp.min()} → {df.timestamp.max()}')
print(f'Close range: {df.close.min():.2f} – {df.close.max():.2f}')
print(df.head(3))
" "$PQ"
```

**Pass criteria:**
- [ ] Parquet file exists in `data/crypto/`
- [ ] File has 6 columns: timestamp, open, high, low, close, volume
- [ ] ~2000+ rows (Jan-Mar 2024 at 1h ≈ 2160 bars)
- [ ] Timestamps span 2024-01-01 to 2024-03-01
- [ ] Build agent references price stats in its strategy design

---

## Test 2 — Stock extraction from Research mode

**Mode:** Research (Tab to switch)

**Send:**
```text
I'm researching a NVDA momentum strategy. Get me 1d data for all of 2024 and tell me the stats.
```

**Observe in TUI:**
1. Research agent spawns `data_extractor`
2. Since NVDA is a stock, only yfinance is tried (no Binance)
3. Task completes with digest showing price stats, performance, volume

**Verify on disk:**
```bash
ls -la ~/.local/share/finny/algos/$ALGO/data/stock/
# Expected: NVDA_1d_2024-01-01_2024-12-31.parquet (or similar range)
```

**Pass criteria:**
- [ ] Parquet file exists in `data/stock/` (NOT `data/crypto/`)
- [ ] ~250 rows (trading days in 2024)
- [ ] Research agent reports meaningful stats from the digest

---

## Test 3 — Chat mode extraction with stats request

**Mode:** Chat (Tab to switch)

**Send:**
```text
Can you pull 1h ETH data from June to December 2024 and tell me the stats?
```

**Observe in TUI:**
1. Chat agent spawns `data_extractor`
2. Binance tried first (ETH is crypto), yfinance as fallback
3. Digest shows price summary, performance metrics, data quality

**Verify on disk:**
```bash
ls -la ~/.local/share/finny/algos/$ALGO/data/crypto/
# Expected: ETH-USD_1h_2024-06-01_2024-12-01.parquet (dates may be adjusted)
```

**Pass criteria:**
- [ ] Parquet in `data/crypto/`
- [ ] ~4300+ rows (6 months at 1h)
- [ ] Chat agent mentions return %, volatility, drawdown from the digest

---

## Test 4 — Multi-symbol extraction (pairs trading)

**Mode:** Build

**Send:**
```text
Build a pairs trading strategy for BTC and ETH using 4h data from 2024
```

**Observe in TUI:**
1. Build agent spawns `data_extractor`
2. Subagent calls `finny_extract_data` twice — once for BTC, once for ETH
3. Both show progress in the TUI
4. Combined digest returned to Build agent

**Verify on disk:**
```bash
ls -la ~/.local/share/finny/algos/$ALGO/data/crypto/
# Expected: two parquet files
# BTC-USD_4h_2024-01-01_2024-12-31.parquet
# ETH-USD_4h_2024-01-01_2024-12-31.parquet
```

**Pass criteria:**
- [ ] Two separate parquet files in `data/crypto/`
- [ ] Both ~2190 rows (365 days × 6 bars/day)
- [ ] Build agent uses both datasets in strategy design

---

## Test 5 — Unknown symbol error handling

**Mode:** Chat

**Send:**
```text
Pull 1h data for FAKECOIN/USD from 2024
```

**Observe in TUI:**
1. `data_extractor` spawns
2. Both Binance and yfinance fail
3. Digest reports `no_data` with error details

**Verify:**
- [ ] No parquet file created for FAKECOIN
- [ ] Agent reports the failure clearly and asks user to verify the symbol

---

## Test 6 — Subagent child session navigation

After any successful extraction:

1. Click on the collapsed task summary:
   ```text
   └ data_extractor · 1 tool call · 23s
   ```
2. TUI should navigate to the child session

**Verify in child session:**
- [ ] Footer shows subagent info:
  ```text
  ┌─ Subagent (1 of 1) ────────────────┐
  │ data_extractor · X tokens · $X.XX   │
  │ [↑ Parent]                          │
  └─────────────────────────────────────┘
  ```
- [ ] `finny_extract_data` tool call is visible with parameters
- [ ] Output shows the full markdown digest

---

## Test 7 — Extraction without active algo

First, ensure no algo is active (or pass an explicit name).

**Mode:** Chat

**Send:**
```text
Pull BTC 1h data from January 2024
```

**Observe:**
- If no active algo → agent should report "No active algorithm" and suggest
  creating one or passing `algorithm_name` explicitly
- If active algo exists → normal extraction flow

---

## Test 8 — Verify data quality in digest

**Mode:** Chat

**Send:**
```text
Extract SOL/USD 15m data from 2024-03-01 to 2024-03-15 and show me the quality report
```

**Verify in agent response (digest):**
- [ ] `Coverage: XX%` — should be high (>95% for 2-week window)
- [ ] `Gaps: N` — number of gaps > 1.5× expected step
- [ ] `OHLC violations: N` — should be 0 for real data
- [ ] `Outliers: N` — count of >8σ moves

---

## Quick verification script

Run this after any extraction to verify the full pipeline:

```bash
#!/bin/bash
# Usage: ./verify-extraction.sh <parquet-path>

PQ="$1"
if [ -z "$PQ" ] || [ ! -f "$PQ" ]; then
    echo "Usage: $0 <path-to-parquet>"
    exit 1
fi

python3 -c "
import pandas as pd
import sys

df = pd.read_parquet('$PQ')

# Schema check
expected_cols = ['timestamp', 'open', 'high', 'low', 'close', 'volume']
assert list(df.columns) == expected_cols, f'Bad columns: {list(df.columns)}'

# No NaN
for col in expected_cols[1:]:
    assert not df[col].isna().any(), f'NaN in {col}'

# OHLC invariant
assert (df['low'] <= df['open']).all(), 'low > open violation'
assert (df['low'] <= df['close']).all(), 'low > close violation'
assert (df['high'] >= df['open']).all(), 'high < open violation'
assert (df['high'] >= df['close']).all(), 'high < close violation'

# Volume non-negative
assert (df['volume'] >= 0).all(), 'negative volume found'

# Monotonic timestamps
assert df['timestamp'].is_monotonic_increasing, 'timestamps not sorted'

# No duplicates
assert df['timestamp'].nunique() == len(df), f'{len(df) - df.timestamp.nunique()} duplicate timestamps'

print(f'✓ Schema:     {list(df.columns)}')
print(f'✓ Rows:       {len(df)}')
print(f'✓ Range:      {df.timestamp.iloc[0]} → {df.timestamp.iloc[-1]}')
print(f'✓ Close:      {df.close.min():.2f} – {df.close.max():.2f}')
print(f'✓ Volume avg: {df.volume.mean():.2f}')
print(f'✓ No NaN, no OHLC violations, no dupes, monotonic timestamps')
print(f'  ALL CHECKS PASSED')
"
```
