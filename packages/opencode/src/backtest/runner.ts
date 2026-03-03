import fs from "fs/promises"
import os from "os"
import path from "path"
import { Process } from "@/util/process"
import type { Algorithm } from "@/algorithm"

export namespace BacktestRunner {
  export interface Params {
    algorithm: Algorithm.Info
    duration: string // "1m" | "3m" | "6m" | "1y"
    interval: string // "1min" | "5min" | "15min" | "30min" | "1h" | "4h" | "1d"
    capital: string // "1000" | "5000" | "10000" | "50000" | "100000"
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

  export type RunResult = { ok: true; results: Results } | { ok: false; error: string }

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

  function computeDateRange(duration: string): { start: string; end: string } {
    const months = DURATION_MONTHS[duration] ?? 3
    const end = new Date()
    const start = new Date()
    start.setMonth(start.getMonth() - months)
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    }
  }

  function makeFetchDataScript(symbol: string, start: string, end: string, interval: string, csvPath: string): string {
    return `
import subprocess, sys

try:
    import yfinance
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "yfinance", "-q"])
    import yfinance

import yfinance as yf

ticker = yf.Ticker("${symbol}")
df = ticker.history(start="${start}", end="${end}", interval="${interval}")
if df.empty:
    print("ERROR: No market data found for ${symbol}", file=sys.stderr)
    sys.exit(1)

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

  export async function run(params: Params): Promise<RunResult> {
    const { algorithm, duration, interval, capital } = params

    if (!algorithm.backtestCode) {
      return { ok: false, error: "Algorithm has no backtest code. Re-build the algorithm with backtest support." }
    }
    if (!algorithm.config) {
      return { ok: false, error: "Algorithm has no config. Re-build the algorithm with a config file." }
    }

    let tmpDir: string | undefined
    try {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-backtest-"))

      // Write strategy.py
      await fs.writeFile(path.join(tmpDir, "strategy.py"), algorithm.code)

      // Write backtest.py
      await fs.writeFile(path.join(tmpDir, "backtest.py"), algorithm.backtestCode)

      // Parse and patch config with user's capital
      let config: any
      try {
        config = JSON.parse(algorithm.config)
      } catch {
        return { ok: false, error: "Failed to parse algorithm config JSON." }
      }
      config.risk = config.risk ?? {}
      config.risk.starting_equity_usd = parseFloat(capital)
      await fs.writeFile(path.join(tmpDir, "config.json"), JSON.stringify(config, null, 2))

      // Compute dates and symbol
      const { start, end } = computeDateRange(duration)
      const symbol = toYfinanceSymbol(config.symbol ?? "ETH/USD")
      const yfinanceInterval = INTERVAL_MAP[interval] ?? "1h"
      const csvPath = "ohlcv.csv"

      // Write and run fetch data script
      const fetchScript = makeFetchDataScript(symbol, start, end, yfinanceInterval, csvPath)
      await fs.writeFile(path.join(tmpDir, "_fetch_data.py"), fetchScript)

      // Check python3 exists
      let pythonCmd = "python3"
      try {
        await Process.run(["python3", "--version"])
      } catch {
        try {
          await Process.run(["python", "--version"])
          pythonCmd = "python"
        } catch {
          return { ok: false, error: "Python not found. Install Python 3 to run backtests." }
        }
      }

      // Fetch market data
      const fetchResult = await Process.run([pythonCmd, "_fetch_data.py"], {
        cwd: tmpDir,
        nothrow: true,
      })

      if (fetchResult.code !== 0) {
        const stderr = fetchResult.stderr.toString().trim()
        if (stderr.includes("No market data found")) {
          return { ok: false, error: `No market data found for ${symbol} in the requested period.` }
        }
        return { ok: false, error: `Failed to download market data: ${stderr || "unknown error"}` }
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
        return { ok: false, error: `Backtest failed: ${stderr || "unknown error"}` }
      }

      const stdout = backtestResult.stdout.toString()
      const results = parseResults(stdout)
      if (!results) {
        return { ok: false, error: "Failed to parse backtest results from output." }
      }

      return { ok: true, results }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? "Unexpected error running backtest." }
    } finally {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}
