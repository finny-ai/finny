# Tasks & TODOs

Current development tasks for Finny.

---

## In Progress

- [ ] Fix research mode transition tool error
- [ ] Fix repeated Grep/WebFetch loops in research mode

---

## Phase 1: Core Functionality

### Completed

- [x] Fork OpenCode to Finny
- [x] Create quant agent prompts (build, research, debug, backtest, chat)
- [x] Implement `/build` command
- [x] Implement `/deploy` command
- [x] Implement `/research` command
- [x] Strategy validator (AST-based)
- [x] AlgoClash integration (localhost:8000)
- [x] TUI with mode switching

### Pending

- [ ] Add `quant_research_complete` tool (signals mode transition)
- [ ] Add `quant_backtest_complete` tool
- [ ] Add `quant_debug_complete` tool
- [ ] Improve error messages for validation failures
- [ ] Add `/schema` endpoint support in AlgoClash

---

## Phase 2: Enhancements

### Backtesting

- [ ] Historical data fetching with yfinance
- [ ] Backtest results visualization
- [ ] Performance metrics (Sharpe, drawdown, etc.)

### Strategy Management

- [ ] Save multiple strategies (not just `latest.py`)
- [ ] Strategy versioning
- [ ] Compare strategy performance

### Data Sources

- [ ] Integrate financialdatasets.ai for real-time
- [ ] Add Twelve Data as backup
- [ ] Cache historical data locally

---

## Phase 3: Polish

### UX Improvements

- [ ] Better transition prompts between modes
- [ ] Progress indicators for long operations
- [ ] Syntax highlighting in strategy output

### Documentation

- [ ] Complete README.md
- [ ] Add video tutorials
- [ ] API documentation

### Testing

- [ ] Unit tests for validator
- [ ] Integration tests for full flow
- [ ] Edge case strategies

---

## Bugs

| ID | Description | Status |
|----|-------------|--------|
| B1 | Research mode tries to use non-existent Task agent | Fixed |
| B2 | Model loops on Grep/WebFetch when tool missing | Fixed |
| B3 | Empty transition tool causes undefined error | Pending |

---

## Ideas (Backlog)

- [ ] Strategy marketplace
- [ ] Leaderboards for AlgoClash
- [ ] Real-money trading integration (Phase 4+)
- [ ] Multi-symbol strategies
- [ ] Options/futures support
- [ ] Social features (share strategies)
- [ ] Mobile app for monitoring

---

## Recently Completed

### Feb 2, 2026

- Created `quant_research_complete`, `quant_backtest_complete`, `quant_debug_complete` tools
- Added tools to registry
- Added claude_code documentation to git

### Feb 1, 2026

- Initial TUI with trading modes
- Quant sidebar component
- Mode transition system

---

## Notes

- Keep Phase 1 simple - local only
- AST validator is critical - never use regex
- Strategy state resets on AlgoClash restart (acceptable for Phase 1)
- Focus on BTC/ETH/SOL + AAPL/NVDA/PLTR for initial testing
