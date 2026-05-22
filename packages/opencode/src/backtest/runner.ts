import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Process } from "@/util/process"
import type { Algorithm } from "@/algorithm"
import { FINNY_BROKER_PY } from "./broker-py"
import { ensurePythonEnv } from "@/python/env"
import { resolveSymbol } from "@/data/symbols"
import { EngineV2 } from "./results"
import { emit } from "@/analytics/emit"

export namespace BacktestRunner {
  export interface Params {
    algorithm: Algorithm.Info
    duration: string // "1w" | "1m" | "3m" | "6m" | "1y"
    interval: string // "1min" | "5min" | "15min" | "30min" | "1h" | "4h" | "1d"
    capital: string // "1000" | "5000" | "10000" | "50000" | "100000"
    // When set, overrides the duration-derived window. ISO YYYY-MM-DD.
    // Used by walk-forward backtests to run two adjacent windows on the same algo.
    startDate?: string
    endDate?: string
    // Patches merged into config.json before running. Top-level keys are
    // shallow-replaced unless both old and new values are plain objects, in
    // which case they're shallow-merged (so e.g. configOverrides.params replaces
    // the whole params object, while configOverrides.risk merges with existing).
    // Used by sweep to vary strategy params per combo.
    configOverrides?: Record<string, unknown>
  }

  export interface Diagnostics {
    barsProcessed: number
    buyAttempts: number
    sellAttempts: number
    rejectedOrders: number
    rejectionReasons: Record<string, number>
    priceFirst: number
    priceLast: number
    priceRangePct: number
    strategyErrors: number
  }

  export interface Results {
    totalReturn: number
    maxDrawdown: number
    annualizedVolatility: number
    sharpeRatio: number
    endingEquity: number
    totalTrades: number
    winRate: number
    profitFactor: number
    sortino?: number
    calmar?: number
    var95?: number
    cvar95?: number
    maxDdDuration?: number
    timeInMarket?: number
    diagnostics?: Diagnostics
    /**
     * Full engine_v2 result blob. Present when the run completed via the v2
     * engine (the default). Carries all the new metric blocks, trades, MC,
     * walk-forward, regimes, etc. Consumers that want depth should read this
     * instead of the legacy flat fields above.
     */
    v2?: EngineV2.Results
  }

  /** Stable error codes surfaced from {@link run}. UI/telemetry can branch on these. */
  export type ErrorKind =
    | "unknown_symbol"
    | "empty_window"
    | "network"
    | "python_env"
    | "config_invalid"
    | "results_unparseable"
    | "internal"

  export type RunResult =
    | { ok: true; results: Results }
    | { ok: false; error: string; kind: ErrorKind; suggestions?: string[] }

  export class UnknownSymbolError extends Error {
    readonly input: string
    readonly suggestions: string[]
    constructor(input: string, suggestions: string[]) {
      super(
        `Unknown symbol "${input}".` +
          (suggestions.length ? ` Try one of: ${suggestions.join(", ")}.` : ""),
      )
      this.name = "UnknownSymbolError"
      this.input = input
      this.suggestions = suggestions
    }
  }

  /**
   * Top-8 first-class suggestions to surface when a symbol can't be resolved
   * at all. The full curated list is much longer now (50+) but listing all of
   * them in an error message is just noise. Resolution is permissive — any
   * plausible ticker passes — so this only fires on true garbage like
   * empty strings or non-ASCII junk.
   */
  const SUPPORTED_CANONICAL = ["BTC/USD", "ETH/USD", "SOL/USD", "AAPL", "NVDA", "TSLA", "SPY", "QQQ"]

  const DURATION_MONTHS: Record<string, number> = {
    "1m": 1,
    "3m": 3,
    "6m": 6,
    "1y": 12,
  }

  const INTERVAL_MAP: Record<string, string> = {
    "1min": "1m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
  }

  function toYfinanceSymbol(symbol: string): string {
    // "ETH/USD" → "ETH-USD"
    return symbol.replace("/", "-")
  }

  // Parse a duration token of the form `<int><unit>` where unit is one of
  // d / w / m / y. Returns the number of calendar days the window represents
  // (used for free-tier gating). Returns null on unparseable input.
  export function parseDurationDays(duration: string): number | null {
    const m = /^(\d+)([dwmy])$/.exec(duration.trim().toLowerCase())
    if (!m) return null
    const n = parseInt(m[1], 10)
    if (!Number.isFinite(n) || n <= 0) return null
    switch (m[2]) {
      case "d": return n
      case "w": return n * 7
      case "m": return n * 30
      case "y": return n * 365
    }
    return null
  }

  function computeDateRange(duration: string): { start: string; end: string } {
    const end = new Date()
    const start = new Date()
    const m = /^(\d+)([dwmy])$/.exec(duration.trim().toLowerCase())
    if (m) {
      const n = parseInt(m[1], 10)
      switch (m[2]) {
        case "d": start.setDate(start.getDate() - n); break
        case "w": start.setDate(start.getDate() - n * 7); break
        case "m": start.setMonth(start.getMonth() - n); break
        case "y": start.setFullYear(start.getFullYear() - n); break
      }
    } else {
      // Legacy fallback for any pre-existing tokens not matching <int><unit>.
      const months = DURATION_MONTHS[duration] ?? 3
      start.setMonth(start.getMonth() - months)
    }
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    }
  }

  function makeFetchDataScript(symbol: string, start: string, end: string, interval: string, csvPath: string): string {
    // Sentinels parsed by classifyFetchError() — keep prefix and field order stable.
    return `
import sys

try:
    import yfinance as yf
except ImportError as e:
    print(f"__FINNY_FETCH_ERROR__: python_env: yfinance import failed: {e}", file=sys.stderr)
    sys.exit(2)

ticker = yf.Ticker("${symbol}")
try:
    df = ticker.history(start="${start}", end="${end}", interval="${interval}")
except Exception as e:
    msg = str(e).lower()
    if "404" in msg or "delisted" in msg or "not found" in msg:
        print(f"__FINNY_FETCH_ERROR__: unknown_symbol: ${symbol}: {e}", file=sys.stderr)
        sys.exit(3)
    if "timeout" in msg or "connection" in msg or "network" in msg or "max retries" in msg:
        print(f"__FINNY_FETCH_ERROR__: network: ${symbol}: {e}", file=sys.stderr)
        sys.exit(4)
    # Unknown exception class -- emit "internal" instead of misclassifying
    # as network. classifyFetchError on the TS side maps the kind into the
    # user-visible message; "network" implied a connectivity issue we do
    # not actually know about.
    print(f"__FINNY_FETCH_ERROR__: internal: ${symbol}: {e}", file=sys.stderr)
    sys.exit(6)

if df.empty:
    print(f"__FINNY_FETCH_ERROR__: empty_window: ${symbol}: no bars between ${start} and ${end} at ${interval}", file=sys.stderr)
    sys.exit(5)

df = df.reset_index()
# Normalize column names for the backtest harness
rename = {}
for col in df.columns:
    lc = col.strip().lower()
    if lc in ("date", "datetime"):
        rename[col] = "timestamp"
    elif lc == "open":
        rename[col] = "open"
    elif lc == "high":
        rename[col] = "high"
    elif lc == "low":
        rename[col] = "low"
    elif lc == "close":
        rename[col] = "close"
    elif lc == "volume":
        rename[col] = "volume"

df = df.rename(columns=rename)

# Ensure timestamp column exists
if "timestamp" not in df.columns:
    # Use the first column as timestamp (yfinance index)
    df = df.rename(columns={df.columns[0]: "timestamp"})

required = {"timestamp", "open", "high", "low", "close", "volume"}
missing = required - set(df.columns)
if missing:
    print(f"ERROR: Missing columns: {missing}", file=sys.stderr)
    sys.exit(1)

df[["timestamp", "open", "high", "low", "close", "volume"]].to_csv("${csvPath}", index=False)
print(f"Downloaded {len(df)} rows")
`
  }

  /**
   * Parse engine_v2 results.json (preferred — emits the full result blob)
   * with a fallback to the legacy line-format stdout. The line format stays
   * supported so any external strategy that ships its own backtest.py keeps
   * working without modification.
   */
  async function parseResults(stdout: string, tmpDir: string): Promise<Results | null> {
    const jsonPath = path.join(tmpDir, "results.json")
    try {
      const raw = await fs.readFile(jsonPath, "utf8")
      const v2 = JSON.parse(raw) as EngineV2.Results
      const major = parseInt((v2.schema_version || "0").split(".")[0], 10)
      if (major === EngineV2.SCHEMA_VERSION_MAJOR) {
        return {
          totalReturn: v2.total_return,
          maxDrawdown: v2.max_drawdown,
          annualizedVolatility: v2.ann_vol,
          sharpeRatio: v2.ann_sharpe,
          endingEquity: v2.ending_equity,
          totalTrades: v2.total_trades,
          winRate: v2.win_rate,
          profitFactor: v2.profit_factor,
          // Extended metrics from v2 sub-blocks
          sortino: v2.ratios?.sortino,
          calmar: v2.ratios?.calmar ?? undefined,
          var95: v2.risk?.var_95,
          cvar95: v2.risk?.cvar_95,
          maxDdDuration: v2.drawdown?.max_dd_duration_bars,
          timeInMarket: v2.exposure?.time_in_market_pct != null ? v2.exposure.time_in_market_pct / 100 : undefined,
          v2,
        }
      }
      // Schema major mismatch — fall through to line parse; emit a marker so
      // telemetry can see this happened.
      console.warn(`[backtest] results.json schema ${v2.schema_version} not v${EngineV2.SCHEMA_VERSION_MAJOR}; falling back to line parse`)
    } catch {
      // No JSON — strategy probably ran via a legacy embedded backtest.py
    }

    const lines = stdout.split("\n")
    const metrics: Record<string, number> = {}
    for (const line of lines) {
      const match = line.match(/^([\w_]+):\s*([-\d.eE+inf]+)/)
      if (match) {
        const val = parseFloat(match[2])
        if (isFinite(val)) metrics[match[1]] = val
      }
    }
    if (!("ending_equity" in metrics)) return null

    let diagnostics: Diagnostics | undefined
    const totalTrades = metrics["total_trades"] ?? 0
    const diagBars = metrics["diag_bars_processed"]
    // Only attach diagnostics on zero-trade runs to keep payloads lean
    if (diagBars !== undefined && totalTrades === 0) {
      let rejectionReasons: Record<string, number> = {}
      const rrLine = lines.find(l => l.startsWith("diag_rejection_reasons:"))
      if (rrLine) {
        try { rejectionReasons = JSON.parse(rrLine.split(": ", 2)[1]) } catch {}
      }
      diagnostics = {
        barsProcessed: diagBars,
        buyAttempts: metrics["diag_buy_attempts"] ?? 0,
        sellAttempts: metrics["diag_sell_attempts"] ?? 0,
        rejectedOrders: metrics["diag_rejected_orders"] ?? 0,
        rejectionReasons,
        priceFirst: metrics["diag_price_first"] ?? 0,
        priceLast: metrics["diag_price_last"] ?? 0,
        priceRangePct: metrics["diag_price_range_pct"] ?? 0,
        strategyErrors: metrics["diag_strategy_errors"] ?? 0,
      }
    }

    return {
      totalReturn: metrics["total_return"] ?? 0,
      maxDrawdown: metrics["max_drawdown"] ?? 0,
      annualizedVolatility: metrics["ann_vol"] ?? 0,
      sharpeRatio: metrics["ann_sharpe"] ?? 0,
      endingEquity: metrics["ending_equity"] ?? 0,
      totalTrades: metrics["total_trades"] ?? 0,
      winRate: metrics["win_rate"] ?? 0,
      profitFactor: metrics["profit_factor"] ?? 0,
      sortino: metrics["sortino"],
      calmar: metrics["calmar"],
      var95: metrics["var_95"],
      cvar95: metrics["cvar_95"],
      maxDdDuration: metrics["max_dd_duration"],
      timeInMarket: metrics["time_in_market"],
      diagnostics,
    }
  }

  /**
   * Default backtest.py shim used when an algorithm doesn't ship its own
   * runner. Uses finny_broker.py's SimBroker + load_strategy() to run the
   * strategy bar-by-bar. Outputs legacy key: value lines that the TS parser
   * expects. Algorithms that supply their own `backtestCode` bypass this shim.
   */
  const DEFAULT_BACKTEST_PY = String.raw`#!/usr/bin/env python3
"""Default Finny backtest runner — SimBroker + dynamic strategy loader."""
import argparse, csv, json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from finny_broker import SimBroker, ScanBroker, load_strategy

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--interval", required=True)
    ap.add_argument("--capital", type=float, required=True)
    ap.add_argument("--scan-only", action="store_true")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    symbol = cfg.get("symbol", "ETH/USD")
    params = cfg.get("params", {})

    bars = []
    with open(args.csv, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            bars.append({
                "timestamp": row.get("timestamp") or row.get("Timestamp") or row.get("date"),
                "open": float(row.get("open") or row.get("Open", 0)),
                "high": float(row.get("high") or row.get("High", 0)),
                "low": float(row.get("low") or row.get("Low", 0)),
                "close": float(row.get("close") or row.get("Close", 0)),
                "volume": float(row.get("volume") or row.get("Volume", 0)),
                "symbol": symbol,
            })

    if not bars:
        print("ending_equity: 0", file=sys.stderr)
        sys.exit(1)

    # ── PRE-FLIGHT SIGNAL SCAN ──
    if args.scan_only:
        scan = ScanBroker(starting_cash=args.capital)
        strategy_path = Path(__file__).parent / "strategy.py"
        scan_step = load_strategy(strategy_path, scan, params=params)
        scan_strategy_errors = 0
        for bar in bars:
            scan.set_price(symbol, bar["close"])
            try:
                scan_step(symbol, bar)
            except Exception:
                scan_strategy_errors += 1
            scan.mark_to_market()
        print(f"scan_buy_signals: {scan.buy_signals}")
        print(f"scan_sell_signals: {scan.sell_signals}")
        print(f"scan_strategy_errors: {scan_strategy_errors}")
        print(f"scan_bars_total: {len(bars)}")
        return

    # ── FULL BACKTEST ──
    broker = SimBroker(starting_cash=args.capital)
    strategy_path = Path(__file__).parent / "strategy.py"
    step = load_strategy(strategy_path, broker, params=params)

    bar_count = 0
    strategy_errors = 0
    price_high = -math.inf
    price_low = math.inf
    first_price = bars[0]["close"]
    last_price = bars[-1]["close"]

    for bar in bars:
        broker.set_price(symbol, bar["close"])
        bar_count += 1
        px = bar["close"]
        if px > price_high:
            price_high = px
        if px < price_low:
            price_low = px
        try:
            step(symbol, bar)
        except Exception as e:
            strategy_errors += 1
            print(f"[backtest] strategy error at {bar.get('timestamp','?')}: {e}", file=sys.stderr)
        broker.mark_to_market()

    eq_curve = broker.equity_curve
    ending = eq_curve[-1] if eq_curve else args.capital
    eq_curve = [max(0.0, e) for e in eq_curve]
    ending = max(0.0, ending)

    # ── UNITS CONTRACT ────────────────────────────────────────────────
    total_return = (ending / args.capital - 1) if args.capital > 0 else 0.0

    peak = args.capital
    max_dd = 0.0
    max_dd_duration = 0
    dd_start_bar = 0
    for i, eq in enumerate(eq_curve):
        if eq >= peak:
            peak = eq
            dd_start_bar = i
        dd = (peak - eq) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
        if dd > 0:
            dur = i - dd_start_bar
            if dur > max_dd_duration:
                max_dd_duration = dur
    max_dd = min(max_dd, 1.0)

    pnls = broker.trade_pnls
    total_trades = len(pnls)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    win_rate = (len(wins) / total_trades) if total_trades > 0 else 0.0
    win_rate = max(0.0, min(1.0, win_rate))
    gross_profit = sum(wins) if wins else 0
    gross_loss = abs(sum(losses)) if losses else 0
    profit_factor_raw = (gross_profit / gross_loss) if gross_loss > 0 else (999.0 if gross_profit > 0 else 0)
    profit_factor = min(profit_factor_raw, 50.0)

    if len(eq_curve) > 1:
        returns = [(eq_curve[i] / eq_curve[i-1] - 1) for i in range(1, len(eq_curve)) if eq_curve[i-1] > 0]
        if returns:
            mean_r = sum(returns) / len(returns)
            var_r = sum((r - mean_r) ** 2 for r in returns) / len(returns)
            std_r = math.sqrt(var_r)
            interval_map = {"1min": 525600, "5min": 105120, "15min": 35040, "30min": 17520, "1h": 8760, "4h": 2190, "1d": 365}
            bpy = interval_map.get(args.interval, 8760)
            ann_vol = std_r * math.sqrt(bpy)
            ann_sharpe = (mean_r / std_r * math.sqrt(bpy)) if std_r > 0 else 0
            # Sortino: downside deviation only
            neg_returns = [r for r in returns if r < 0]
            if neg_returns:
                down_var = sum(r ** 2 for r in neg_returns) / len(neg_returns)
                down_dev = math.sqrt(down_var) * math.sqrt(bpy)
                sortino = (mean_r * bpy) / down_dev if down_dev > 0 else 0
            else:
                sortino = 0 if mean_r <= 0 else 20.0
            # Calmar: annualized return / max drawdown
            ann_return = mean_r * bpy
            calmar = ann_return / max_dd if max_dd > 0.001 else (20.0 if ann_return > 0 else 0)
            # VaR / CVaR (95%)
            sorted_returns = sorted(returns)
            var_idx = max(0, int(len(sorted_returns) * 0.05) - 1)
            var_95 = abs(sorted_returns[var_idx]) if sorted_returns else 0
            cvar_tail = sorted_returns[:var_idx + 1]
            cvar_95 = abs(sum(cvar_tail) / len(cvar_tail)) if cvar_tail else 0
            # Time in market: count bars where position was non-zero
            bars_in_market = sum(1 for h in broker.position_history if h != 0) if hasattr(broker, 'position_history') else 0
            time_in_market = bars_in_market / max(1, bar_count)
        else:
            ann_vol = ann_sharpe = sortino = calmar = var_95 = cvar_95 = time_in_market = 0
    else:
        ann_vol = ann_sharpe = sortino = calmar = var_95 = cvar_95 = time_in_market = 0

    ann_vol = min(ann_vol, 5.0)
    ann_sharpe = max(-20.0, min(20.0, ann_sharpe))
    sortino = max(-20.0, min(20.0, sortino))
    calmar = max(-20.0, min(20.0, calmar))

    low_sample = 1 if total_trades < 10 else 0

    # ── Core metrics ──
    print(f"total_return: {total_return:.6f}")
    print(f"max_drawdown: {max_dd:.6f}")
    print(f"ann_vol: {ann_vol:.6f}")
    print(f"ann_sharpe: {ann_sharpe:.6f}")
    print(f"ending_equity: {ending:.2f}")
    print(f"total_trades: {total_trades}")
    print(f"win_rate: {win_rate:.6f}")
    print(f"profit_factor: {profit_factor:.4f}")
    print(f"low_sample: {low_sample}")

    # ── Extended metrics ──
    print(f"sortino: {sortino:.4f}")
    print(f"calmar: {calmar:.4f}")
    print(f"var_95: {var_95:.6f}")
    print(f"cvar_95: {cvar_95:.6f}")
    print(f"max_dd_duration: {max_dd_duration}")
    print(f"time_in_market: {time_in_market:.4f}")

    # ── Diagnostics (always emitted; parsed when total_trades == 0) ──
    diag = broker.diagnostics()
    print(f"diag_bars_processed: {bar_count}")
    print(f"diag_buy_attempts: {diag['buy_attempts']}")
    print(f"diag_sell_attempts: {diag['sell_attempts']}")
    print(f"diag_rejected_orders: {diag['rejected_orders']}")
    print(f"diag_rejection_reasons: {json.dumps(diag['rejection_reasons'])}")
    print(f"diag_price_first: {first_price:.6f}")
    print(f"diag_price_last: {last_price:.6f}")
    price_range_pct = (price_high - price_low) / first_price if first_price > 0 else 0
    print(f"diag_price_range_pct: {price_range_pct:.6f}")
    print(f"diag_strategy_errors: {strategy_errors}")

if __name__ == "__main__":
    main()
`


  // Tokens commonly seen in algo names that are NOT tickers. Anything else that
  // looks like a ticker shape (2-5 alnum chars) is treated as a candidate symbol.
  const NAME_STOPWORDS = new Set([
    // Strategy patterns
    "INTRADAY", "HYBRID", "MOMENTUM", "MEAN", "REVERSION", "BREAKOUT", "DCA", "GOLDEN",
    "CROSS", "SCALPING", "SCALP", "SWING", "TREND", "RANGE", "FOLLOW", "FOLLOWING",
    "ARBITRAGE", "ARB", "PAIRS", "STAT", "GRID", "MARTINGALE", "ANTI",
    // Indicators
    "RSI", "SMA", "EMA", "MACD", "BB", "BOLLINGER", "ATR", "STOCH", "PIVOT", "FIB",
    "FIBONACCI", "ICHIMOKU", "VWAP", "OBV", "ADX", "CCI", "WILLIAMS", "DONCHIAN",
    // Generic
    "STRATEGY", "STRAT", "ALGO", "ALGORITHM", "BOT", "TRADER", "TRADING", "QUANT",
    "SIMPLE", "ADVANCED", "BASIC", "ML", "AI", "ALPHA", "BETA", "GAMMA", "DELTA",
    "FAST", "SLOW", "SHORT", "LONG", "HIGH", "LOW", "UP", "DOWN", "DAY", "NIGHT",
    "TEST", "DEMO", "DRAFT", "PROD", "PROD", "PRO", "LITE", "PLUS", "MINI", "MAX",
    "NEW", "OLD", "CUSTOM", "FINAL", "DRAFT", "WIP", "TMP",
    // Version tokens
    "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10",
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  ])

  // Crypto base tickers that need a `/USD` quote suffix when handed to yfinance.
  const CRYPTO_BASES = new Set([
    "BTC", "ETH", "SOL", "ADA", "DOT", "LINK", "UNI", "AAVE", "MATIC", "AVAX",
    "XRP", "DOGE", "SHIB", "LTC", "BCH", "ATOM", "NEAR", "FTM", "ALGO", "XLM",
    "TRX", "ETC", "FIL", "ICP", "APT", "ARB", "OP", "INJ", "SEI", "TIA", "SUI",
    "PEPE", "WLD", "RNDR", "IMX", "FET", "GRT", "STX", "MKR", "RUNE", "LDO",
  ])

  function looksLikeTicker(token: string): boolean {
    // 1-5 alphanumeric characters, starts with a letter.
    return /^[A-Z][A-Z0-9]{0,4}$/.test(token)
  }

  /**
   * Canonicalize any user-supplied symbol shape (BTC, btc, BTC-USD, BTC/USD,
   * BTCUSD, BTCUSDT) into the canonical form Finny uses internally
   * ("BTC/USD" for crypto, "AAPL" for equities). Mirrors the Python
   * {@link AlpacaBroker.normalize_symbol} so the broker (Python) and the
   * backtest data fetch (TS) can never disagree on format.
   *
   * Throws {@link UnknownSymbolError} when input cannot be coerced into any
   * plausible ticker shape — empty strings, garbage tokens, etc.
   */
  export function normalizeSymbol(input: string): string {
    const raw = (input ?? "").trim()
    if (!raw) throw new UnknownSymbolError(input ?? "", SUPPORTED_CANONICAL)

    // Registry hit (BTC, BTC-USD, BTC/USD, BTCUSD, BTCUSDT, AAPL, …).
    const supported = resolveSymbol(raw)
    if (supported) return supported.canonical

    const upper = raw.toUpperCase().replace(/\s+/g, "")

    // Pair forms with explicit separator: BASE/QUOTE or BASE-QUOTE.
    const sep = upper.match(/^([A-Z][A-Z0-9]{0,5})[-/](USD|USDT|USDC)$/)
    if (sep) return `${sep[1]}/USD`

    // Glued pair: BTCUSDT, BTCUSD, BTCUSDC.
    const glued = upper.match(/^([A-Z][A-Z0-9]{0,5})(USDT|USDC|USD)$/)
    if (glued) return `${glued[1]}/USD`

    // Bare crypto base from the wider universe (XRP, DOGE, …).
    if (CRYPTO_BASES.has(upper)) return `${upper}/USD`

    // Bare equity ticker.
    if (looksLikeTicker(upper)) return upper

    throw new UnknownSymbolError(raw, SUPPORTED_CANONICAL)
  }

  /** Stderr-sentinel parser — see makeFetchDataScript for emit contract. */
  export function classifyFetchError(stderr: string): { kind: ErrorKind; detail: string } {
    const m = stderr.match(/__FINNY_FETCH_ERROR__:\s*(\w+):\s*([\s\S]*)/)
    if (m) {
      const kind = m[1] as ErrorKind
      return { kind, detail: m[2].trim() }
    }
    const lower = stderr.toLowerCase()
    if (lower.includes("externally-managed-environment") || lower.includes("no module named")) {
      return { kind: "python_env", detail: stderr.trim() }
    }
    if (lower.includes("404") || lower.includes("delisted") || lower.includes("symbol may be delisted") || lower.includes("no data found")) {
      return { kind: "unknown_symbol", detail: stderr.trim() }
    }
    if (lower.includes("timeout") || lower.includes("connection") || lower.includes("network")) {
      return { kind: "network", detail: stderr.trim() }
    }
    return { kind: "internal", detail: stderr.trim() || "unknown error" }
  }

  function detectSymbol(algorithm: Algorithm.Info): string {
    // 1. Try the strategy code for an explicit SYMBOL = "..." or "symbol": "..."
    const code = algorithm.code || ""
    const m1 = code.match(/SYMBOL\s*=\s*["']([^"']+)["']/)
    if (m1) return safeNormalize(m1[1])
    const m2 = code.match(/["']symbol["']\s*:\s*["']([^"']+)["']/)
    if (m2) return safeNormalize(m2[1])

    // 2. Tokenize the algorithm name and pick the first ticker-shaped token that
    //    isn't a known strategy/indicator/version word. This handles any equity
    //    or crypto without needing a hardcoded list — "uco-intraday-hybrid" → UCO,
    //    "tsla-momentum-v2" → TSLA, "eth-mean-reversion" → ETH → ETH/USD, etc.
    const name = (algorithm.name || "").toUpperCase()
    for (const rawToken of name.split(/[-_\s.]+/)) {
      const token = rawToken.trim()
      if (!token) continue
      if (NAME_STOPWORDS.has(token)) continue
      if (!looksLikeTicker(token)) continue
      try {
        return normalizeSymbol(token)
      } catch {
        continue
      }
    }

    // 3. Fall back to crypto default.
    return "BTC/USD"
  }

  /**
   * Best-effort normalize: returns the canonical form when the input parses,
   * otherwise the trimmed original. Used inside detectSymbol where an
   * unrecognized declaration should still be visible to the rest of the run
   * (so the error attribution path classifies it cleanly).
   */
  function safeNormalize(input: string): string {
    try {
      return normalizeSymbol(input)
    } catch {
      return (input ?? "").trim()
    }
  }

  export function classifyAssetClass(algorithm: Algorithm.Info): "crypto" | "equity" | "unknown" {
    // Prefer an explicit symbol from the config JSON.
    let symbol: string | undefined
    if (algorithm.config) {
      try {
        const c = JSON.parse(algorithm.config)
        if (typeof c?.symbol === "string") symbol = c.symbol
      } catch {}
    }
    // Fall back to scanning the strategy code.
    if (!symbol && algorithm.code) {
      const m1 = algorithm.code.match(/SYMBOL\s*=\s*["']([^"']+)["']/)
      if (m1) symbol = m1[1]
      const m2 = algorithm.code.match(/["']symbol["']\s*:\s*["']([^"']+)["']/)
      if (!symbol && m2) symbol = m2[1]
    }
    if (!symbol) return "unknown"

    const upper = symbol.toUpperCase()
    // Explicit crypto pair markers: "/USD", "-USD", "/USDT", "-USDT", "/USDC", "-USDC".
    if (/[-/](USD|USDT|USDC)$/.test(upper)) return "crypto"
    // Bare base ticker that looks like a crypto.
    const base = upper.split(/[-/]/)[0]
    if (CRYPTO_BASES.has(base)) return "crypto"
    // Everything else — AAPL, TSLA, SPY, UCO, QQQ, etc. — is equities for now.
    return "equity"
  }

  function synthesizeConfig(algorithm: Algorithm.Info): string {
    const symbol = detectSymbol(algorithm)
    return JSON.stringify(
      {
        symbol,
        risk: { starting_equity_usd: 10000 },
        _generated: "fallback — algorithm had no config",
      },
      null,
      2,
    )
  }

  export async function run(params: Params): Promise<RunResult> {
    const { algorithm, duration, interval, capital, startDate, endDate, configOverrides } = params

    // Fallbacks: synthesize default backtest.py and config.json if the algo is missing them.
    const backtestCode = algorithm.backtestCode && algorithm.backtestCode.trim().length > 0
      ? algorithm.backtestCode
      : DEFAULT_BACKTEST_PY
    const algorithmConfig = algorithm.config && algorithm.config.trim().length > 0
      ? algorithm.config
      : synthesizeConfig(algorithm)

    let tmpDir: string | undefined
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-backtest-"))

      // Write finny_broker.py — SimBroker + load_strategy() used by the
      // DEFAULT_BACKTEST_PY shim and by algorithms with custom backtestCode.
      await fs.writeFile(path.join(tmpDir, "finny_broker.py"), FINNY_BROKER_PY)

      // Write strategy.py
      await fs.writeFile(path.join(tmpDir, "strategy.py"), algorithm.code)

      // Write backtest.py (user-supplied or DEFAULT shim → finny_broker.SimBroker)
      await fs.writeFile(path.join(tmpDir, "backtest.py"), backtestCode)

      // Copy engine_v2/ into the tmpdir — only needed by algorithms with
      // custom backtestCode that imports engine_v2. The default shim uses
      // finny_broker.py directly, so a missing engine_v2 is non-fatal.
      const ENGINE_V2_SRC = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..", "..", "engine_v2",
      )
      try {
        await fs.cp(ENGINE_V2_SRC, path.join(tmpDir, "engine_v2"), { recursive: true })
      } catch {
        // Non-fatal: default backtest shim doesn't need engine_v2
      }

      // Parse and patch config with user's capital
      let config: any
      try {
        config = JSON.parse(algorithmConfig)
      } catch {
        return { ok: false, error: "Failed to parse algorithm config JSON.", kind: "config_invalid" }
      }
      config.risk = config.risk ?? {}
      config.risk.starting_equity_usd = parseFloat(capital)

      // Canonicalize the configured symbol up front so a mismatch between
      // strategy code (e.g. "BTCUSDT") and the data layer (yfinance "BTC-USD")
      // can never silently produce empty data — and so failures at this layer
      // get an `unknown_symbol` attribution instead of a generic stderr blob.
      if (config.symbol) {
        try {
          config.symbol = normalizeSymbol(String(config.symbol))
        } catch (e) {
          if (e instanceof UnknownSymbolError) {
            return {
              ok: false,
              error: e.message,
              kind: "unknown_symbol",
              suggestions: e.suggestions,
            }
          }
          throw e
        }
      }

      if (configOverrides) {
        for (const [k, v] of Object.entries(configOverrides)) {
          const isPlainObj = (x: unknown): x is Record<string, unknown> =>
            x !== null && typeof x === "object" && !Array.isArray(x)
          if (isPlainObj(v) && isPlainObj(config[k])) {
            config[k] = { ...config[k], ...v }
          } else {
            config[k] = v
          }
        }
      }

      // Re-normalize symbol AFTER overrides — an override could reintroduce a
      // non-canonical form (e.g. param sweep passing "btcusdt") and undo the
      // canonicalization above. Cheap to redo; expensive when symbol drift
      // produces empty yfinance results downstream.
      if (config.symbol) {
        try {
          config.symbol = normalizeSymbol(String(config.symbol))
        } catch (e) {
          if (e instanceof UnknownSymbolError) {
            return { ok: false, error: e.message, kind: "unknown_symbol", suggestions: e.suggestions }
          }
          throw e
        }
      }

      await fs.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(config, null, 2))

      // Compute dates and symbol — explicit start/end win over duration-derived window.
      const computed = computeDateRange(duration)
      const start = startDate ?? computed.start
      const end = endDate ?? computed.end
      const symbol = toYfinanceSymbol(config.symbol ?? "ETH/USD")
      const yfinanceInterval = INTERVAL_MAP[interval] ?? "1h"
      const csvPath = "ohlcv.csv"

      // Write and run fetch data script
      const fetchScript = makeFetchDataScript(symbol, start, end, yfinanceInterval, csvPath)
      await fs.writeFile(path.join(tmpDir, "_fetch_data.py"), fetchScript)

      // Use the managed venv. yfinance is installed once, lazily, on first use.
      let pythonCmd: string
      try {
        const env = await ensurePythonEnv([
          { spec: "yfinance", importCheck: "yfinance" },
          { spec: "scipy", importCheck: "scipy" },
          { spec: "pyarrow", importCheck: "pyarrow" },
        ])
        pythonCmd = env.python
      } catch (e: any) {
        return {
          ok: false,
          error: e?.message ?? "Failed to set up the managed Python environment.",
          kind: "python_env",
        }
      }

      // Fetch market data — wall-clock cap so a stalled yfinance pull can't
      // hang the tool executor indefinitely. 2 minutes is generous for a
      // single fetch; healthy ones complete in under 5 seconds.
      const fetchResult = await Process.run([pythonCmd, "_fetch_data.py"], {
        cwd: tmpDir,
        nothrow: true,
        timeout: 120_000,
      })

      if (fetchResult.code !== 0) {
        const stderr = fetchResult.stderr.toString().trim()
        const { kind, detail } = classifyFetchError(stderr)
        const human =
          kind === "unknown_symbol"
            ? `Backtest failed (unknown_symbol): ${symbol} is not a recognized symbol. ` +
              `Try one of: ${SUPPORTED_CANONICAL.join(", ")}.`
            : kind === "empty_window"
              ? `Backtest failed (empty_window): no bars for ${symbol} between ${start} and ${end} at ${yfinanceInterval}. Try a wider duration or a coarser interval.`
              : kind === "network"
                ? `Backtest failed (network): could not reach the market data provider. ${detail}`
                : kind === "python_env"
                  ? `Backtest failed (python_env): ${detail}`
                  : `Backtest failed: ${detail || "unknown error"}`
        return {
          ok: false,
          error: human,
          kind,
          suggestions: kind === "unknown_symbol" ? SUPPORTED_CANONICAL : undefined,
        }
      }

      // Pre-flight signal scan — fast dry run to detect 0-signal strategies
      // before spending time on a full backtest.
      const scanResult = await Process.run(
        [pythonCmd, "backtest.py", "--csv", csvPath, "--config", "config.json", "--interval", interval, "--capital", capital, "--scan-only"],
        { cwd: tmpDir, nothrow: true, timeout: 60_000 },
      )
      if (scanResult.code === 0) {
        const scanOut = scanResult.stdout.toString()
        const scanBuys = parseInt(scanOut.match(/scan_buy_signals:\s*(\d+)/)?.[1] ?? "1", 10)
        const scanErrors = parseInt(scanOut.match(/scan_strategy_errors:\s*(\d+)/)?.[1] ?? "0", 10)
        const scanBars = parseInt(scanOut.match(/scan_bars_total:\s*(\d+)/)?.[1] ?? "0", 10)
        // Only short-circuit if zero signals AND no strategy errors (errors could mask real signals)
        if (scanBuys === 0 && scanBars > 0 && scanErrors === 0) {
          emit({
            eventType: "backtest.scan_zero_signals",
            algorithmId: algorithm.algorithmId,
            payload: { scanBars, duration, interval, capital },
          })
          return {
            ok: true,
            results: {
              totalReturn: 0, maxDrawdown: 0, annualizedVolatility: 0, sharpeRatio: 0,
              endingEquity: parseFloat(capital), totalTrades: 0, winRate: 0, profitFactor: 0,
              diagnostics: {
                barsProcessed: scanBars, buyAttempts: 0, sellAttempts: 0,
                rejectedOrders: 0, rejectionReasons: {},
                priceFirst: 0, priceLast: 0, priceRangePct: 0, strategyErrors: 0,
              },
            },
          }
        }
      }

      // Run backtest — generous wall-clock cap (5 min) for full history runs
      // with many bars. If a strategy infinite-loops on bad logic, this stops
      // the session from being held hostage.
      const backtestResult = await Process.run(
        [pythonCmd, "backtest.py", "--csv", csvPath, "--config", "config.json", "--interval", interval, "--capital", capital],
        {
          cwd: tmpDir,
          nothrow: true,
          timeout: 300_000,
        },
      )

      if (backtestResult.code !== 0) {
        const stderr = backtestResult.stderr.toString().trim()
        emit({
          eventType: "backtest.failed",
          algorithmId: algorithm.algorithmId,
          payload: { error: stderr || "unknown error", kind: "internal", duration, interval, capital },
        })
        return { ok: false, error: `Backtest failed: ${stderr || "unknown error"}`, kind: "internal" }
      }

      const stdout = backtestResult.stdout.toString()
      const results = await parseResults(stdout, tmpDir!)
      if (!results) {
        emit({
          eventType: "backtest.failed",
          algorithmId: algorithm.algorithmId,
          payload: { error: "results_unparseable", kind: "results_unparseable", duration, interval, capital },
        })
        return { ok: false, error: "Failed to parse backtest results from output.", kind: "results_unparseable" }
      }

      emit({
        eventType: "backtest.completed",
        algorithmId: algorithm.algorithmId,
        payload: { results, duration, interval, capital, code: algorithm.code },
      })
      return { ok: true, results }
    } catch (e: any) {
      emit({
        eventType: "backtest.failed",
        algorithmId: algorithm.algorithmId,
        payload: { error: e?.message ?? "Unexpected error", kind: "internal", duration, interval, capital },
      })
      return { ok: false, error: e?.message ?? "Unexpected error running backtest.", kind: "internal" }
    } finally {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
