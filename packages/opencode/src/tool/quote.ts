import z from "zod"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Process } from "@/util/process"
import { resolveSessionPythonEnv } from "@/python/session-env"
import { resolveSymbol, SUPPORTED_SYMBOLS } from "../data/symbols"
import { Database } from "@opencode-ai/core/database/database"
import { StrategyContext } from "@/task/strategy-context"

const parameters = z.object({
  symbol: z
    .string()
    .describe(
      "Symbol to quote. Accepts canonical (BTC/USD, AAPL), yfinance (BTC-USD), or bare ticker (BTC). " +
        "Must resolve to one of the supported markets.",
    ),
})

function makeQuoteScript(yfSymbol: string): string {
  // yfinance is guaranteed to be installed by the managed venv before this
  // script runs (see ensurePythonEnv call below). No subprocess pip install
  // needed — and on PEP 668 / no-pip Linux that fallback was broken anyway.
  return `
import json, sys
import yfinance as yf

t = yf.Ticker("${yfSymbol}")
df = t.history(period="2d", interval="1m")
if df.empty:
    df = t.history(period="5d", interval="1h")
if df.empty:
    # Exit 0 — caller parses stdout for the {"error": "no data"} sentinel
    # and maps it to a clean "no_data" tool result. Exiting non-zero would
    # route through the stderr-based fetch_failed path and the structured
    # error would be lost.
    print(json.dumps({"error": "no data"}))
    sys.exit(0)

last = df.iloc[-1]
ts = df.index[-1]
out = {
  "symbol": "${yfSymbol}",
  "price": float(last["Close"]),
  "open": float(last["Open"]),
  "high": float(last["High"]),
  "low": float(last["Low"]),
  "volume": float(last["Volume"]),
  "timestamp": ts.isoformat(),
}
print(json.dumps(out))
`
}

export const QuoteTool = Tool.define(
  "finny_get_quote",
  Effect.gen(function* () {
    const database = yield* Effect.serviceOption(Database.Service)
    return {
    description:
      "Get the latest quote (price, OHLCV, timestamp) for a supported market symbol. " +
      "Use this when the user asks for a current price or to anchor a strategy parameter " +
      "in real numbers. Backed by yfinance — same data source as backtests.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<Tool.ExecuteResult> => {
        const contextBlock =
          database._tag === "Some"
            ? await StrategyContext.duplicateFetchBlock(
                "Live market-data fetch",
                ctx.sessionID,
                database.value,
                ctx.messages,
              )
            : undefined
        if (contextBlock) return contextBlock
        await ctx.ask({
          permission: "finny_get_quote",
          patterns: ["*"],
          always: ["*"],
          metadata: { symbol: params.symbol },
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

        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-quote-"))
        try {
          const scriptPath = path.join(tmpDir, "_quote.py")
          await fs.writeFile(scriptPath, makeQuoteScript(resolved.yfinance))

          let pythonCmd: string
          try {
            const env = await resolveSessionPythonEnv(ctx.sessionID, [
              { spec: "yfinance", importCheck: "yfinance" },
            ])
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
            // Hard wall-clock cap — yfinance / network can hang indefinitely
            // and a stuck quote would tie up the session's tool executor.
            // 30s is generous: a healthy fetch is sub-second.
            timeout: 30_000,
            // Wire ctx.abort so cancelling the session also kills this child.
            abort: ctx.abort,
          })
          if (result.code !== 0) {
            const stderr = result.stderr.toString().trim()
            return {
              title: "Quote failed",
              output: `Failed to fetch quote for ${resolved.yfinance}: ${stderr || "unknown error"}`,
              metadata: { error: "fetch_failed", symbol: resolved.canonical },
            }
          }

          const stdout = result.stdout.toString().trim()
          let parsed: any
          try {
            parsed = JSON.parse(stdout)
          } catch {
            return {
              title: "Quote failed",
              output: `Could not parse quote response: ${stdout.slice(0, 200)}`,
              metadata: { error: "parse_failed", symbol: resolved.canonical },
            }
          }
          if (parsed?.error) {
            return {
              title: "No data",
              output: `No recent data available for ${resolved.canonical}.`,
              metadata: { error: "no_data", symbol: resolved.canonical },
            }
          }

          const lines = [
            `Symbol: ${resolved.canonical}`,
            `Price:  ${parsed.price.toFixed(2)}`,
            `OHLC:   ${parsed.open.toFixed(2)} / ${parsed.high.toFixed(2)} / ${parsed.low.toFixed(2)} / ${parsed.price.toFixed(2)}`,
            `Volume: ${parsed.volume}`,
            `As of:  ${parsed.timestamp}`,
            `Source: yfinance`,
          ]
          return {
            title: `${resolved.canonical} @ ${parsed.price.toFixed(2)}`,
            output: lines.join("\n"),
            metadata: {
              symbol: resolved.canonical,
              price: parsed.price,
              timestamp: parsed.timestamp,
            },
          }
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        }
      }),
    }
  }),
)
