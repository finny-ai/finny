# Plan: Database Setup (Supabase PostgreSQL)

## Overview
Set up Supabase PostgreSQL as the backend database for Algoclash and Finny's server-side features. The local CLI will continue using SQLite for session data.

## Architecture

```
Finny CLI (local)          Algoclash Server (monorepo)
├── SQLite (sessions,      ├── Supabase PostgreSQL
│   messages, local        │   ├── users
│   state)                 │   ├── algorithms
│                          │   ├── deployments
│                          │   ├── paper_trades
│                          │   ├── leaderboard
│                          │   ├── portfolios
│                          │   └── live_connections
│                          │
└── REST API calls ──────► └── Hono API server
    (deploy, status,           (packages/algoclash/)
     leaderboard)
```

## New Package: `packages/algoclash/`

```
packages/algoclash/
├── package.json           # @finny-ai/algoclash
├── tsconfig.json
├── drizzle.config.ts      # PostgreSQL + Supabase connection
├── migration/             # Drizzle migration files
├── src/
│   ├── index.ts           # Exports
│   ├── db.ts              # Supabase/Drizzle connection
│   ├── schema/            # Database schema files
│   │   ├── user.sql.ts
│   │   ├── algorithm.sql.ts
│   │   ├── deployment.sql.ts
│   │   ├── trade.sql.ts
│   │   ├── portfolio.sql.ts
│   │   └── leaderboard.sql.ts
│   ├── api/               # Hono API routes
│   │   ├── server.ts      # Main Hono app
│   │   ├── auth.ts        # User auth routes
│   │   ├── deploy.ts      # Algorithm deployment
│   │   ├── status.ts      # Live metrics
│   │   ├── leaderboard.ts # Rankings
│   │   └── portfolio.ts   # Portfolio data
│   ├── engine/            # Paper trading simulation
│   │   ├── simulator.ts   # Core simulation loop
│   │   ├── market-feed.ts # Real-time price feeds
│   │   └── executor.ts    # Order execution
│   └── data/              # Market data connectors
│       ├── yfinance.ts    # Historical data (free)
│       └── live-feed.ts   # Real-time feed (user API key)
└── test/
```

## Database Schema

### `users`
```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE,
  api_key       TEXT UNIQUE NOT NULL,     -- for CLI auth
  alpaca_key    TEXT,                      -- encrypted, for /live
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

### `algorithms`
```sql
CREATE TABLE algorithms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  name          TEXT NOT NULL,
  description   TEXT,
  code          TEXT NOT NULL,             -- strategy.py content
  config        JSONB NOT NULL,            -- config.json parameters
  asset_class   TEXT NOT NULL,             -- 'stock', 'crypto', 'options', 'forex'
  timeframe     TEXT NOT NULL,             -- 'scalp', 'intraday', 'swing', 'position'
  version       INTEGER DEFAULT 1,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

### `deployments`
```sql
CREATE TABLE deployments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  algorithm_id  UUID REFERENCES algorithms(id),
  user_id       UUID REFERENCES users(id),
  mode          TEXT NOT NULL,             -- 'paper' or 'live'
  status        TEXT DEFAULT 'active',     -- 'active', 'paused', 'stopped', 'error'
  started_at    TIMESTAMPTZ DEFAULT now(),
  stopped_at    TIMESTAMPTZ,
  config        JSONB,                     -- runtime overrides
  initial_capital NUMERIC(15,2) DEFAULT 100000.00
);
```

### `trades`
```sql
CREATE TABLE trades (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID REFERENCES deployments(id),
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL,             -- 'buy' or 'sell'
  quantity      NUMERIC(15,6) NOT NULL,
  price         NUMERIC(15,6) NOT NULL,
  type          TEXT DEFAULT 'market',     -- 'market', 'limit'
  status        TEXT DEFAULT 'filled',     -- 'filled', 'partial', 'cancelled'
  pnl           NUMERIC(15,6),            -- realized P&L for this trade
  executed_at   TIMESTAMPTZ DEFAULT now()
);
```

### `portfolios`
```sql
CREATE TABLE portfolios (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID REFERENCES deployments(id),
  timestamp     TIMESTAMPTZ DEFAULT now(),
  equity        NUMERIC(15,2) NOT NULL,    -- total portfolio value
  cash          NUMERIC(15,2) NOT NULL,
  positions     JSONB,                     -- current open positions
  drawdown      NUMERIC(8,4),             -- current drawdown %
  pnl_total     NUMERIC(15,2),            -- cumulative P&L
  pnl_today     NUMERIC(15,2)             -- today's P&L
);
-- Index on (deployment_id, timestamp) for equity curve queries
```

### `leaderboard_snapshots`
```sql
CREATE TABLE leaderboard_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID REFERENCES deployments(id),
  user_id       UUID REFERENCES users(id),
  roi           NUMERIC(8,4) NOT NULL,     -- return on investment %
  win_rate      NUMERIC(5,2),              -- win rate %
  sharpe_ratio  NUMERIC(6,3),
  max_drawdown  NUMERIC(8,4),
  total_trades  INTEGER DEFAULT 0,
  rank          INTEGER,
  period        TEXT DEFAULT 'all_time',   -- 'daily', 'weekly', 'monthly', 'all_time'
  snapshot_at   TIMESTAMPTZ DEFAULT now()
);
-- Index on (period, roi DESC) for leaderboard queries
```

## Connection Setup

```typescript
// packages/algoclash/src/db.ts
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

const connectionString = process.env.SUPABASE_DATABASE_URL!
const client = postgres(connectionString)
export const db = drizzle(client)
```

## Environment Variables
```
SUPABASE_DATABASE_URL=postgresql://...@db.xxx.supabase.co:5432/postgres
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...    # server-side only
```

## Dependencies to Add
```json
{
  "dependencies": {
    "drizzle-orm": "catalog:",
    "postgres": "^3.4.0",
    "hono": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "drizzle-kit": "catalog:",
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

## Implementation Steps
1. Create `packages/algoclash/` package structure
2. Set up Supabase project + get connection string
3. Define Drizzle schemas (`.sql.ts` files)
4. Run initial migration
5. Create Hono API server with first route (`/health`)
6. Wire into monorepo workspace
