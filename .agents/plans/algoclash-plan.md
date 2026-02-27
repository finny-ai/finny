# Plan: Algoclash Platform (Full)

## Overview
Community-driven algorithm simulation platform where users deploy trading algorithms for paper trading. Features leaderboard, user profiles, equity charts, algorithm code viewing, and portfolio tracking. Connects to Finny CLI via REST API.

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Finny CLI (local)                     │
│                                                         │
│  User types: "Build me a crypto momentum strategy"      │
│  → AI generates algorithm files locally                 │
│  → /deploy sends algorithm to Algoclash API             │
│  → /status polls live metrics from Algoclash            │
│  → /live deploys locally via Alpaca (not Algoclash)     │
└──────────────┬──────────────────────────────────────────┘
               │ REST API (Bearer token auth)
               ▼
┌─────────────────────────────────────────────────────────┐
│              Algoclash Server (Hono API)                 │
│              packages/algoclash/                         │
│                                                         │
│  POST /v1/auth/register     - Create account + API key  │
│  POST /v1/auth/login        - Get token                 │
│  POST /v1/algo/deploy       - Submit algorithm          │
│  POST /v1/algo/stop         - Stop deployment           │
│  GET  /v1/algo/:id/status   - Live metrics              │
│  GET  /v1/algo/:id/trades   - Trade history             │
│  GET  /v1/algo/:id/equity   - Equity curve data         │
│  GET  /v1/algo/:id/code     - View algorithm code       │
│  GET  /v1/leaderboard       - Rankings (period filter)  │
│  GET  /v1/user/:id          - User profile + algos      │
│  GET  /v1/user/:id/portfolio- Portfolio summary         │
│  POST /v1/backtest          - Run backtest              │
│  GET  /v1/backtest/:id      - Backtest results          │
└──────────────┬──────────────────────────────────────────┘
               │
     ┌─────────┴──────────┐
     ▼                    ▼
┌──────────┐    ┌──────────────────┐
│ Supabase │    │ Market Data Feeds │
│ Postgres │    │                  │
│          │    │ Real-time:       │
│ users    │    │   Financial      │
│ algos    │    │   Dataset API    │
│ trades   │    │   (user key)     │
│ portfol. │    │                  │
│ leader.  │    │ Historical:      │
│          │    │   yfinance       │
│          │    │   (free)         │
└──────────┘    └──────────────────┘
```

## Package Structure

```
packages/algoclash/
├── package.json                # @finny-ai/algoclash
├── tsconfig.json
├── drizzle.config.ts
├── migration/                  # DB migrations
│
├── src/
│   ├── index.ts                # Package exports
│   │
│   ├── db/
│   │   ├── client.ts           # Supabase/Drizzle connection
│   │   └── schema/
│   │       ├── user.sql.ts
│   │       ├── algorithm.sql.ts
│   │       ├── deployment.sql.ts
│   │       ├── trade.sql.ts
│   │       ├── portfolio.sql.ts
│   │       └── leaderboard.sql.ts
│   │
│   ├── api/
│   │   ├── server.ts           # Main Hono app + middleware
│   │   ├── middleware/
│   │   │   ├── auth.ts         # Bearer token validation
│   │   │   └── rate-limit.ts   # Rate limiting
│   │   ├── routes/
│   │   │   ├── auth.ts         # /v1/auth/*
│   │   │   ├── algo.ts         # /v1/algo/*
│   │   │   ├── leaderboard.ts  # /v1/leaderboard
│   │   │   ├── user.ts         # /v1/user/*
│   │   │   └── backtest.ts     # /v1/backtest
│   │   └── validators/
│   │       ├── algo.ts         # Zod schemas for algo endpoints
│   │       └── backtest.ts     # Zod schemas for backtest
│   │
│   ├── engine/
│   │   ├── simulator.ts        # Paper trading simulation loop
│   │   ├── executor.ts         # Order matching against market data
│   │   ├── risk-manager.ts     # Enforce stop-loss, max drawdown
│   │   └── portfolio-tracker.ts# Track positions, equity, P&L
│   │
│   ├── data/
│   │   ├── feed.ts             # Unified market data interface
│   │   ├── yfinance.ts         # Historical data via yfinance (Python subprocess)
│   │   ├── live-feed.ts        # Real-time via Financial Dataset API
│   │   └── symbols.ts          # Symbol resolution (AAPL, BTC-USD, etc.)
│   │
│   ├── leaderboard/
│   │   ├── calculator.ts       # ROI, Sharpe, win rate computation
│   │   └── ranker.ts           # Periodic ranking updates
│   │
│   └── algo/
│       ├── runner.ts           # Execute user algorithm in sandbox
│       ├── sandbox.ts          # Isolated execution (subprocess/container)
│       └── validator.ts        # Validate algorithm structure before deploy
│
└── test/
    ├── api.test.ts
    ├── simulator.test.ts
    └── fixtures/
```

## API Endpoints Detail

### Authentication
```
POST /v1/auth/register
  Body: { username, email?, password }
  Returns: { user_id, api_key }
  → User saves api_key in Finny CLI config

POST /v1/auth/login
  Body: { username, password } OR { api_key }
  Returns: { token } (JWT, short-lived)
```

### Algorithm Deployment
```
POST /v1/algo/deploy
  Auth: Bearer token
  Body: {
    name: "Crypto Momentum v1",
    code: "...strategy.py content...",
    config: { ...config.json... },
    asset_class: "crypto",
    timeframe: "intraday",
    initial_capital: 100000
  }
  Returns: { deployment_id, status: "active" }
  → Server starts paper trading simulation

POST /v1/algo/:deployment_id/stop
  Auth: Bearer token
  Returns: { status: "stopped", final_metrics: {...} }
```

### Live Metrics
```
GET /v1/algo/:deployment_id/status
  Returns: {
    status: "active",
    equity: 102500.00,
    pnl_total: 2500.00,
    pnl_today: 150.00,
    drawdown: -1.2,
    open_positions: [...],
    total_trades: 47,
    win_rate: 58.5,
    sharpe_ratio: 1.82,
    uptime: "3d 14h 22m"
  }

GET /v1/algo/:deployment_id/equity
  Query: ?period=7d
  Returns: [{ timestamp, equity, drawdown }]  // for equity chart

GET /v1/algo/:deployment_id/trades
  Query: ?limit=50&offset=0
  Returns: [{ symbol, side, qty, price, pnl, executed_at }]

GET /v1/algo/:deployment_id/code
  Returns: { code, config, name, description }
```

### Leaderboard
```
GET /v1/leaderboard
  Query: ?period=weekly&asset_class=crypto&limit=50
  Returns: [{
    rank, username, algorithm_name,
    roi, win_rate, sharpe_ratio, max_drawdown,
    total_trades, deployment_id
  }]
```

### User Profiles
```
GET /v1/user/:username
  Returns: {
    username, joined_at,
    algorithms: [{ name, asset_class, status }],
    stats: { total_algos, best_roi, avg_sharpe }
  }

GET /v1/user/:username/portfolio
  Returns: {
    total_equity, total_pnl,
    deployments: [{ name, equity, pnl, status }]
  }
```

### Backtesting
```
POST /v1/backtest
  Auth: Bearer token
  Body: {
    code: "...strategy.py...",
    config: {...},
    symbol: "AAPL",
    start_date: "2024-01-01",
    end_date: "2025-01-01",
    initial_capital: 100000
  }
  Returns: { backtest_id, status: "running" }

GET /v1/backtest/:id
  Returns: {
    status: "completed",
    results: {
      roi: 15.2, sharpe: 1.4, max_drawdown: -8.5,
      total_trades: 142, win_rate: 55.3,
      equity_curve: [...],
      trades: [...]
    }
  }
```

## Paper Trading Simulation Engine

### How It Works
1. **Deploy**: User submits algorithm code + config via API
2. **Validate**: Server checks algorithm structure (must have `generate_signals()` function)
3. **Sandbox**: Algorithm runs in isolated subprocess (Bun subprocess or Docker container)
4. **Feed**: Real-time market data streamed to the algorithm
5. **Execute**: When algorithm outputs a signal (buy/sell), executor matches against current market price
6. **Track**: Portfolio tracker updates positions, equity, P&L
7. **Risk**: Risk manager enforces stop-loss, max drawdown — auto-stops if limits hit
8. **Snapshot**: Every 5 minutes, portfolio state saved to DB for equity curve

### Algorithm Interface (what users must implement)
```python
# strategy.py — required interface
class Strategy:
    def __init__(self, config: dict):
        """Initialize with config.json parameters"""
        pass

    def generate_signals(self, market_data: dict) -> list[dict]:
        """Called on each market data tick.
        Returns list of signals:
        [{"action": "buy"|"sell", "symbol": "AAPL", "quantity": 10}]
        """
        pass

    def on_fill(self, trade: dict):
        """Called when an order is filled. Optional."""
        pass
```

### Market Data Feed
```typescript
// Unified interface
interface MarketFeed {
  subscribe(symbols: string[]): AsyncIterable<Tick>
  historical(symbol: string, start: Date, end: Date): Promise<OHLCV[]>
}

// Real-time: Financial Dataset API (user provides key)
// Historical: yfinance via Python subprocess (free)
```

## CLI Integration (Finny side)

### What changes in Finny CLI
The existing `packages/finny-integrations/` already has the HTTP client pattern. We extend it:

```typescript
// New: packages/finny-integrations/src/algoclash.ts
export async function deploy(input: { code: string; config: object; name: string; ... })
export async function status(deploymentId: string)
export async function stop(deploymentId: string)
export async function leaderboard(period?: string)
export async function backtest(input: { code: string; config: object; ... })
```

### Slash Commands (wired in later steps)
```
/deploy   → calls algoclash.deploy() with current algorithm files
/status   → calls algoclash.status() and renders in TUI
/code     → reads local algorithm files and displays
/strategy → lists local algorithms, lets user switch
/backtest → calls algoclash.backtest() and shows results
/live     → LOCAL ONLY: deploys via Alpaca API (not through Algoclash)
```

## Implementation Phases

### Phase 1: Foundation (do first)
1. Create `packages/algoclash/` package + workspace config
2. Set up Supabase project
3. Define all Drizzle schemas
4. Run initial migration
5. Create Hono server with /health endpoint
6. Auth routes (register, login, API key generation)

### Phase 2: Core Deployment
1. Algorithm validation endpoint
2. Deploy endpoint (store algorithm, create deployment)
3. Basic simulator loop (market data → algorithm → trades)
4. yfinance integration for historical data
5. Portfolio tracker (positions, equity, P&L)
6. Status endpoint

### Phase 3: Leaderboard + Profiles
1. Leaderboard calculator (ROI, Sharpe, win rate)
2. Periodic ranking snapshots
3. Leaderboard API endpoint
4. User profile endpoints
5. Portfolio summary endpoint

### Phase 4: Real-time + Backtesting
1. Financial Dataset API integration (live market feed)
2. Real-time simulation (live price updates)
3. Backtest endpoint (historical replay)
4. Backtest results storage + retrieval

### Phase 5: CLI Integration
1. Extend finny-integrations with Algoclash client functions
2. Implement /deploy, /status, /backtest slash commands
3. Implement /code, /strategy commands (local)
4. Implement /live command (Alpaca integration)
5. TUI rendering for status/leaderboard data

## Security Considerations
- Algorithm sandboxing: NEVER execute user code in the main process
- API keys hashed with bcrypt before storage
- Alpaca keys encrypted at rest, never sent to Algoclash server
- Rate limiting on all endpoints
- Algorithm code size limit (100KB)
- Execution timeout per tick (5 seconds)
