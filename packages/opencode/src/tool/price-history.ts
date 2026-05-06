import z from "zod"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Process } from "@/util/process"
import { ensurePythonEnv } from "@/python/env"
import { resolveSymbol, SUPPORTED_SYMBOLS } from "../data/symbols"

const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "1d"] as const
type Interval = (typeof INTERVALS)[number]

// yfinance's native intervals. There is intentionally no `4h` here — yfinance
// does not provide native 4h bars, and silently aliasing it to 1h was lying
// to the model (the response said "4h" but rows were 1h). When client-side
// resampling lands, add "4h" back with a matching downsample step.
const YF_INTERVAL: Record<Interval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "1d": "1d",
}

// yfinance period limits — keep `period` aligned with the interval to avoid empty frames.
const YF_PERIOD: Record<Interval, string> = {
  "1m": "5d",
  "5m": "30d",
  "15m": "60d",
  "30m": "60d",
  "1h": "180d",
  "1d": "5y",
}

const parameters = z.object({
  symbol: z
    .string()
    .describe("Symbol to fetch (BTC, BTC/USD, BTC-USD, AAPL, etc.). Must be a supported market."),
  interval: z
    .enum(INTERVALS)
    .default("1h")
    .describe("Bar interval. yfinance only supports the listed natives; 4h was removed because it aliased to 1h and lied about bar size."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(100)
    .describe("Maximum number of most-recent bars to return. Hard cap: 500."),
})

function makeHistoryScript(yfSymbol: string, interval: string, period: string, limit: number): string {
  // yfinance is guaranteed to be installed by the managed venv before this
  // script runs (see ensurePythonEnv call below). The old subprocess pip
  // install fallback was broken on PEP 668 / no-pip Linux.
  return `
import json, sys
import yfinance as yf

t = yf.Ticker("${yfSymbol}")
df = t.history(period="${period}", interval="${interval}")
if df.empty:
    # Exit 0 — caller parses stdout for the {"error": "no data"} sentinel
    # and maps it to a clean "no_data" tool result. Exiting non-zero would
    # route through the stderr-based fetch_failed path and the structured
    # error would be lost.
    print(json.dumps({"error": "no data"}))
    sys.exit(0)

df = df.tail(${limit})
rows = []
for ts, r in df.iterrows():
    rows.append({
        "timestamp": ts.isoformat(),
        "open": float(r["Open"]),
        "high": float(r["High"]),
        "low": float(r["Low"]),
        "close": float(r["Close"]),
        "volume": float(r["Volume"]),
    })

print(json.dumps({"rows": rows, "count": len(rows)}))
`
}

export const PriceHistoryTool = Tool.define(
  "finny_get_history",
  Effect.succeed({
    description:
      "Fetch historical OHLCV bars for a supported symbol (capped at 500 bars). " +
      "Use this when sizing thresholds against actual volatility, sanity-checking a strategy's " +
      "trigger frequency, or grounding indicator parameters in real bar ranges. " +
      "Backed by yfinance — same data source as backtests.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<Tool.ExecuteResult> => {
        await ctx.ask({
          permission: "finny_get_history",
          patterns: ["*"],
          always: ["*"],
          metadata: { symbol: params.symbol, interval: params.interval, limit: params.limit },
        })

        const resolved = resolveSymbol(params.symbol)
        if (!resolved) {
          const supported = SUPPORTED_SYMBOLS.map((s) => s.name).join(", ")
          return {
            title: "Unknown symbol",
            output: `"${params.symbol}" is not a supported symbol. Supported: ${supported}.`,
            metadata: { error: "unknown_symbol", input: params.symbol },
          }
        }

        const interval = params.interval
        const yfInterval = YF_INTERVAL[interval]
        const yfPeriod = YF_PERIOD[interval]

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-history-"))
        try {
          const scriptPath = path.join(tmpDir, "_history.py")
          await fs.writeFile(scriptPath, makeHistoryScript(resolved.yfinance, yfInterval, yfPeriod, params.limit))

          let pythonCmd: string
          try {
            const env = await ensurePythonEnv([{ spec: "yfinance", importCheck: "yfinance" }])
            pythonCmd = env.python
          } catch (e: any) {
            return {
              title: "Python env failed",
              output: e?.message ?? "Failed to set up the managed Python environment.",
              metadata: { error: "python_env" },
            }
          }

          const result = await Process.run([pythonCmd, scriptPath], {
            cwd: tmpDir,
            nothrow: true,
            // Hard wall-clock cap — see quote.ts for rationale. 60s here
            // because larger history pulls (500 bars at 1m) can be slower
            // than a single quote.
            timeout: 60_000,
            abort: ctx.abort,
          })
          if (result.code !== 0) {
            const stderr = result.stderr.toString().trim()
            return {
              title: "History fetch failed",
              output: `Failed to fetch history for ${resolved.yfinance}: ${stderr || "unknown error"}`,
              metadata: { error: "fetch_failed", symbol: resolved.canonical },
            }
          }

          const stdout = result.stdout.toString().trim()
          let parsed: any
          try {
            parsed = JSON.parse(stdout)
          } catch {
            return {
              title: "History fetch failed",
              output: `Could not parse response: ${stdout.slice(0, 200)}`,
              metadata: { error: "parse_failed", symbol: resolved.canonical },
            }
          }
          if (parsed?.error) {
            return {
              title: "No data",
              output: `No data available for ${resolved.canonical} at ${interval}.`,
              metadata: { error: "no_data", symbol: resolved.canonical },
            }
          }

          const rows: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }> = parsed.rows ?? []
          const summary = rows.length
            ? `${rows.length} bars from ${rows[0].timestamp} to ${rows[rows.length - 1].timestamp}`
            : "0 bars"
          return {
            title: `${resolved.canonical} ${interval} — ${summary}`,
            output: JSON.stringify(
              { symbol: resolved.canonical, interval, count: rows.length, rows },
              null,
              2,
            ),
            metadata: { symbol: resolved.canonical, interval, count: rows.length },
          }
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        }
      }),
  }),
)
