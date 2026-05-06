import fs from "fs/promises"
import os from "os"
import path from "path"
import { Process } from "@/util/process"
import type { Algorithm } from "@/algorithm"
import { FINNY_BROKER_PY } from "./broker-py"
import { ensurePythonEnv } from "@/python/env"
import { resolveSymbol, SUPPORTED_SYMBOLS } from "@/data/symbols"

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

  export interface Results {
    totalReturn: number
    maxDrawdown: number
    annualizedVolatility: number
    sharpeRatio: number
    endingEquity: number
    totalTrades: number
    winRate: number
    profitFactor: number
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
    print(f"__FINNY_FETCH_ERROR__: network: ${symbol}: {e}", file=sys.stderr)
    sys.exit(4)

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

  function parseResults(stdout: string): Results | null {
    const lines = stdout.split("\n")
    const metrics: Record<string, number> = {}

    for (const line of lines) {
      const match = line.match(/^([\w_]+):\s*([-\d.eE+inf]+)/)
      if (match) {
        const key = match[1]
        const val = parseFloat(match[2])
        if (isFinite(val)) {
          metrics[key] = val
        }
      }
    }

    if (!("ending_equity" in metrics)) return null

    return {
      totalReturn: metrics["total_return"] ?? 0,
      maxDrawdown: metrics["max_drawdown"] ?? 0,
      annualizedVolatility: metrics["ann_vol"] ?? 0,
      sharpeRatio: metrics["ann_sharpe"] ?? 0,
      endingEquity: metrics["ending_equity"] ?? 0,
      totalTrades: metrics["total_trades"] ?? 0,
      winRate: metrics["win_rate"] ?? 0,
      profitFactor: metrics["profit_factor"] ?? 0,
    }
  }

  const DEFAULT_BACKTEST_PY = String.raw`import sys, json, csv, argparse, math
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from finny_broker import SimBroker, load_strategy

parser = argparse.ArgumentParser()
parser.add_argument("--csv", required=True)
parser.add_argument("--config", required=True)
parser.add_argument("--interval", required=True)
parser.add_argument("--capital", required=True)
args = parser.parse_args()

with open(args.config) as f:
    config = json.load(f)

symbol = config.get("symbol", "UNKNOWN")
capital = float(args.capital)
broker = SimBroker(starting_cash=capital)

strategy_path = Path(__file__).parent / "strategy.py"
strategy_params = config.get("params") if isinstance(config.get("params"), dict) else {}
try:
    step = load_strategy(strategy_path, broker, params=strategy_params)
except Exception as e:
    print(f"ERROR loading strategy: {e}", file=sys.stderr)
    sys.exit(2)

bar_count = 0
last_close = 0.0

with open(args.csv) as f:
    reader = csv.DictReader(f)
    for row in reader:
        try:
            bar = {
                "timestamp": row["timestamp"],
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
                "symbol": symbol,
            }
        except (KeyError, ValueError):
            continue
        bar_count += 1
        last_close = bar["close"]

        broker.set_price(symbol, bar["open"])

        try:
            step(symbol, bar)
        except Exception as e:
            print(f"[backtest] Strategy raised: {e}", file=sys.stderr)

        broker.set_price(symbol, bar["close"])
        broker.mark_to_market()

# Liquidate any remaining position at the last close to surface realized PnL.
if last_close > 0 and broker.position(symbol) > 0:
    broker.sell(symbol)
    broker.mark_to_market()

starting = broker.starting_cash
ending = broker.cash() + sum(broker.position(s) * (broker.price(s) or 0) for s in [symbol])
total_return = (ending - starting) / starting if starting > 0 else 0.0

curve = broker.equity_curve
peak = curve[0] if curve else starting
max_dd = 0.0
for e in curve:
    if e > peak:
        peak = e
    if peak > 0:
        dd = (peak - e) / peak
        if dd > max_dd:
            max_dd = dd

rets = []
for i in range(1, len(curve)):
    if curve[i - 1] > 0:
        rets.append((curve[i] - curve[i - 1]) / curve[i - 1])

if len(rets) > 1:
    mean_ret = sum(rets) / len(rets)
    var_r = sum((r - mean_ret) ** 2 for r in rets) / (len(rets) - 1)
    std_r = math.sqrt(var_r)
    interval_map = {"1min": 252 * 390, "5min": 252 * 78, "15min": 252 * 26, "30min": 252 * 13,
                    "1h": 252 * 6.5, "4h": 252 * 1.6, "1d": 252}
    ppy = interval_map.get(args.interval, 252)
    ann_vol = std_r * math.sqrt(ppy)
    ann_sharpe = (mean_ret * ppy) / ann_vol if ann_vol > 0 else 0.0
else:
    ann_vol = 0.0
    ann_sharpe = 0.0

pnls = broker.trade_pnls
total_trades = len(pnls)
wins = [p for p in pnls if p > 0]
losses = [p for p in pnls if p <= 0]
win_rate = len(wins) / total_trades if total_trades > 0 else 0.0
gross_profit = sum(wins)
gross_loss = abs(sum(losses))
profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (0.0 if gross_profit == 0 else 999.0)

print(f"total_return: {total_return}")
print(f"max_drawdown: {max_dd}")
print(f"ann_vol: {ann_vol}")
print(f"ann_sharpe: {ann_sharpe}")
print(f"ending_equity: {ending}")
print(f"total_trades: {total_trades}")
print(f"win_rate: {win_rate}")
print(f"profit_factor: {profit_factor}")
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

      // Write finny_broker.py — shared broker abstraction used by strategies
      await fs.writeFile(path.join(tmpDir, "finny_broker.py"), FINNY_BROKER_PY)

      // Write strategy.py
      await fs.writeFile(path.join(tmpDir, "strategy.py"), algorithm.code)

      // Write backtest.py (real or synthesized)
      await fs.writeFile(path.join(tmpDir, "backtest.py"), backtestCode)

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
        const env = await ensurePythonEnv([{ spec: "yfinance", importCheck: "yfinance" }])
        pythonCmd = env.python
      } catch (e: any) {
        return {
          ok: false,
          error: e?.message ?? "Failed to set up the managed Python environment.",
          kind: "python_env",
        }
      }

      // Fetch market data
      const fetchResult = await Process.run([pythonCmd, "_fetch_data.py"], {
        cwd: tmpDir,
        nothrow: true,
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

      // Run backtest
      const backtestResult = await Process.run(
        [pythonCmd, "backtest.py", "--csv", csvPath, "--config", "config.json", "--interval", interval, "--capital", capital],
        {
          cwd: tmpDir,
          nothrow: true,
        },
      )

      if (backtestResult.code !== 0) {
        const stderr = backtestResult.stderr.toString().trim()
        return { ok: false, error: `Backtest failed: ${stderr || "unknown error"}`, kind: "internal" }
      }

      const stdout = backtestResult.stdout.toString()
      const results = parseResults(stdout)
      if (!results) {
        return { ok: false, error: "Failed to parse backtest results from output.", kind: "results_unparseable" }
      }

      return { ok: true, results }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "Unexpected error running backtest.", kind: "internal" }
    } finally {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
