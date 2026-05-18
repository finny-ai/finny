import z from "zod"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Process } from "@/util/process"
import { ensurePythonEnv } from "@/python/env"
import { resolveSymbol, SUPPORTED_SYMBOLS } from "../data/symbols"
import { getActiveAlgo, algoDir } from "@finny-ai/core/algo"

const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const

const parameters = z.object({
  symbol: z
    .string()
    .describe("Symbol to extract data for (BTC/USD, AAPL, ETH, SPY, etc.)."),
  interval: z
    .enum(INTERVALS)
    .default("1h")
    .describe("Bar interval for OHLCV data."),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .describe("Start date (inclusive) in YYYY-MM-DD format."),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .describe("End date (exclusive) in YYYY-MM-DD format."),
  algorithm_name: z
    .string()
    .optional()
    .describe("Target algo name. If omitted, uses the active algo."),
})

function makeExtractScript(
  symbol: string,
  interval: string,
  start: string,
  end: string,
  algoPath: string,
): string {
  return `
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from engine_v2.data.extractor import extract, result_to_json

result = extract(
    symbol=${JSON.stringify(symbol)},
    interval=${JSON.stringify(interval)},
    start=${JSON.stringify(start)},
    end=${JSON.stringify(end)},
    algo_dir=${JSON.stringify(algoPath)},
)
print(result_to_json(result))
`
}

export const ExtractDataTool = Tool.define(
  "finny_extract_data",
  Effect.succeed({
    description:
      "Extract historical OHLCV data for a symbol and write it as a parquet file " +
      "into the active algorithm's data/ folder. Tries multiple sources (Binance for crypto, " +
      "yfinance for stocks/ETFs) and picks the one with the best coverage. Returns a structured " +
      "digest with price stats, performance metrics, and data quality — not raw bars.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<Tool.ExecuteResult> => {
        await ctx.ask({
          permission: "finny_extract_data",
          patterns: ["*"],
          always: ["*"],
          metadata: { symbol: params.symbol, interval: params.interval },
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

        let algoName = params.algorithm_name
        if (!algoName) {
          algoName = await getActiveAlgo() ?? undefined
          if (!algoName) {
            return {
              title: "No active algorithm",
              output:
                "No algorithm is currently active. Either pass algorithm_name explicitly " +
                "or set an active algo first via finny_algorithm_save.",
              metadata: { error: "no_active_algo" },
            }
          }
        }

        const algoPath = algoDir(algoName)

        const ENGINE_V2_SRC = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "..", "..", "engine_v2",
        )
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-extract-"))
        try {
          try {
            await fs.cp(ENGINE_V2_SRC, path.join(tmpDir, "engine_v2"), { recursive: true })
          } catch (e: any) {
            return {
              title: "Extract failed",
              output: `engine_v2 source not found at ${ENGINE_V2_SRC}: ${e?.message ?? e}`,
              metadata: { error: "internal" },
            }
          }

          const scriptPath = path.join(tmpDir, "_extract.py")
          await fs.writeFile(
            scriptPath,
            makeExtractScript(resolved.canonical, params.interval, params.start, params.end, algoPath),
          )

          let pythonCmd: string
          try {
            const env = await ensurePythonEnv([
              { spec: "yfinance", importCheck: "yfinance" },
              { spec: "requests", importCheck: "requests" },
              { spec: "pandas", importCheck: "pandas" },
              { spec: "pyarrow", importCheck: "pyarrow" },
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
            timeout: 120_000,
            abort: ctx.abort,
          })

          if (result.code !== 0) {
            const stderr = result.stderr.toString().trim()
            return {
              title: "Extract failed",
              output: `Failed to extract data for ${resolved.canonical}: ${stderr || "unknown error"}`,
              metadata: { error: "extract_failed", symbol: resolved.canonical },
            }
          }

          const stdout = result.stdout.toString().trim()
          let parsed: any
          try {
            parsed = JSON.parse(stdout)
          } catch {
            return {
              title: "Extract failed",
              output: `Could not parse extractor response: ${stdout.slice(0, 300)}`,
              metadata: { error: "parse_failed", symbol: resolved.canonical },
            }
          }

          if (parsed?.error) {
            return {
              title: "Extract failed",
              output: `Extraction error: ${parsed.error}`,
              metadata: { error: "extract_error", symbol: resolved.canonical },
            }
          }

          const digest = parsed.digest ?? {}
          const barsWritten = parsed.bars_written ?? 0
          const parquetPath = parsed.parquet_path ?? ""
          const sources = (parsed.sources ?? []) as Array<{ provider: string; bars: number; error?: string }>

          const sourcesSummary = sources
            .map((s: any) => (s.error ? `${s.provider}: failed (${s.error})` : `${s.provider}: ${s.bars} bars`))
            .join(", ")

          const lines: string[] = [
            `## Data Extraction: ${resolved.canonical} ${params.interval}`,
            `**Period:** ${params.start} → ${params.end}`,
            `**Bars written:** ${barsWritten}`,
            `**Source:** ${digest.source ?? "none"} (tried: ${sourcesSummary})`,
            `**File:** ${parquetPath}`,
            "",
          ]

          if (digest.price) {
            lines.push(
              `### Price Summary`,
              `- Open: ${digest.price.open} → Close: ${digest.price.close}`,
              `- Range: ${digest.price.low} – ${digest.price.high}`,
              `- Median: ${digest.price.median} | P5: ${digest.price.p5} | P95: ${digest.price.p95}`,
              "",
            )
          }

          if (digest.performance) {
            lines.push(
              `### Performance`,
              `- Total return: ${digest.performance.total_return_pct}%`,
              `- Annualized volatility: ${digest.performance.annualized_volatility_pct}%`,
              `- Max drawdown: ${digest.performance.max_drawdown_pct}%`,
              "",
            )
          }

          if (digest.volume) {
            lines.push(
              `### Volume`,
              `- Average: ${digest.volume.avg_daily}`,
              `- Total: ${digest.volume.total}`,
              "",
            )
          }

          if (digest.quality) {
            lines.push(
              `### Data Quality`,
              `- Coverage: ${digest.quality.coverage_pct}%`,
              `- Gaps: ${digest.quality.gaps} | OHLC violations: ${digest.quality.ohlc_violations} | Outliers: ${digest.quality.outlier_bars}`,
            )
            if (digest.quality.notes?.length) {
              lines.push(`- Notes: ${digest.quality.notes.join("; ")}`)
            }
          }

          return {
            title: `${resolved.canonical} ${params.interval} — ${barsWritten} bars → ${path.basename(parquetPath)}`,
            output: lines.join("\n"),
            metadata: {
              symbol: resolved.canonical,
              interval: params.interval,
              bars: barsWritten,
              parquet_path: parquetPath,
              source: digest.source,
              algo: algoName,
            },
          }
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        }
      }),
  }),
)
