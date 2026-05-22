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
import { getActiveAlgo, algoDir, ensureAlgoWorkspace } from "@finny-ai/core/algo"

function slugifyAlgoName(...parts: string[]): string {
  return parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
}

const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const

// ── Regime classification ──────────────────────────────────────────────────

interface Regime {
  tag: "trending-up" | "trending-down" | "range-bound" | "high-vol-chop"
  confidence: "high" | "medium" | "low"
  rationale: string
}

function classifyRegime(digest: any): Regime {
  const ret = digest?.performance?.total_return_pct ?? 0
  const vol = digest?.performance?.annualized_volatility_pct ?? 0
  const dd = Math.abs(digest?.performance?.max_drawdown_pct ?? 0)

  const price = digest?.price ?? {}
  const high = price.high
  const low = price.low
  const median = price.median
  const range =
    Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(median) && median !== 0
      ? (high - low) / median
      : 0

  // High vol + small net return = chop
  if (vol > 60 && Math.abs(ret) < 10) {
    return { tag: "high-vol-chop", confidence: "high", rationale: `${vol.toFixed(0)}% vol with only ${ret.toFixed(1)}% net return — noise dominates` }
  }
  if (vol > 40 && Math.abs(ret) < 5) {
    return { tag: "high-vol-chop", confidence: "medium", rationale: `${vol.toFixed(0)}% vol with negligible ${ret.toFixed(1)}% return` }
  }

  // Strong directional move
  if (ret > 15) {
    return { tag: "trending-up", confidence: dd < ret * 0.5 ? "high" : "medium", rationale: `+${ret.toFixed(1)}% return with ${dd.toFixed(1)}% max DD` }
  }
  if (ret < -15) {
    return { tag: "trending-down", confidence: "high", rationale: `${ret.toFixed(1)}% return with ${dd.toFixed(1)}% max DD` }
  }

  // Moderate move
  if (ret > 5) {
    return { tag: "trending-up", confidence: "medium", rationale: `+${ret.toFixed(1)}% return, moderate conviction` }
  }
  if (ret < -5) {
    return { tag: "trending-down", confidence: "medium", rationale: `${ret.toFixed(1)}% return` }
  }

  // Small return, low-moderate vol = range
  if (range < 0.3) {
    return { tag: "range-bound", confidence: "high", rationale: `only ${(range * 100).toFixed(0)}% price range with ${ret.toFixed(1)}% net` }
  }
  return { tag: "range-bound", confidence: "medium", rationale: `${ret.toFixed(1)}% net return within ${(range * 100).toFixed(0)}% range` }
}

// ── Parameter suggestions ──────────────────────────────────────────────────

interface Suggestions {
  strategy_type: string[]
  bollinger_width: string
  lookback_bars: string
  stop_loss_pct: string
  take_profit_pct: string
  position_hold_bars: string
  notes: string[]
}

function deriveSuggestions(digest: any, interval: string, regime: Regime): Suggestions {
  const vol = digest?.performance?.annualized_volatility_pct ?? 30
  const dd = Math.abs(digest?.performance?.max_drawdown_pct ?? 10)
  const price = digest?.price ?? {}
  const range = price.high && price.low && price.median ? (price.high - price.low) / price.median : 0.2

  // Bar-level vol estimate (rough)
  const barsPerYear: Record<string, number> = { "1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520, "1h": 8760, "4h": 2190, "1d": 365 }
  const bpy = barsPerYear[interval] ?? 8760
  const barVol = vol / Math.sqrt(bpy) // approximate per-bar stdev in %

  // Bollinger width: tighter in low vol, wider in high vol
  const bWidth = vol < 25 ? "1.5–2.0σ" : vol < 50 ? "2.0–2.5σ" : "2.5–3.0σ"

  // Lookback: shorter in high vol (faster mean reversion), longer in low vol
  const lookback = vol > 50 ? "12–20 bars" : vol > 30 ? "20–40 bars" : "40–60 bars"

  // Stop loss: based on max DD scaled to bar level
  const stopPct = Math.max(barVol * 3, dd * 0.15)
  const stop = `${stopPct.toFixed(1)}–${(stopPct * 1.5).toFixed(1)}%`

  // Take profit: 1.5–2x stop
  const tp = `${(stopPct * 1.5).toFixed(1)}–${(stopPct * 3).toFixed(1)}%`

  // Hold duration
  const hold = vol > 50 ? "4–12 bars" : vol > 30 ? "8–24 bars" : "12–48 bars"

  const stratTypes: string[] = []
  const notes: string[] = []

  switch (regime.tag) {
    case "range-bound":
      stratTypes.push("mean-reversion", "bollinger-band-fade", "RSI-oversold/overbought")
      notes.push("Range-bound regime favors mean-reversion — fade extremes, tight stops")
      break
    case "trending-up":
      stratTypes.push("momentum-pullback", "breakout-continuation", "trend-following-long")
      notes.push("Trending up — favor long-only trend-following and pullback entries; avoid mean-reversion setups")
      break
    case "trending-down":
      stratTypes.push("momentum-short", "breakout-continuation-short", "trend-following-short")
      notes.push("Trending down — favor short-biased trend-following entries; avoid mean-reversion setups")
      break
    case "high-vol-chop":
      stratTypes.push("mean-reversion (wide bands)", "volatility-breakout", "reduced-size-scalping")
      notes.push("High-vol chop — signals will whipsaw; widen bands, reduce position size, or sit out")
      break
  }

  if (dd > 20) notes.push(`Large max DD (${dd.toFixed(1)}%) — size down or widen stops to survive drawdowns`)
  if (barVol > 1) notes.push(`Per-bar vol is high (~${barVol.toFixed(2)}%) — noise will trigger tight stops`)

  return { strategy_type: stratTypes, bollinger_width: bWidth, lookback_bars: lookback, stop_loss_pct: stop, take_profit_pct: tp, position_hold_bars: hold, notes }
}

// ── Data brief builder ─────────────────────────────────────────────────────

function buildDataBrief(p: {
  symbol: string; interval: string; start: string; end: string
  bars: number; source: string; parquetPath: string
  digest: any; regime: Regime; suggestions: Suggestions; workspaceCreated: boolean
}): string {
  const { digest, regime, suggestions: s } = p
  const price = digest?.price ?? {}
  const perf = digest?.performance ?? {}
  const quality = digest?.quality ?? {}

  const lines: string[] = [
    `# Data Brief: ${p.symbol} ${p.interval}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Period | ${p.start} → ${p.end} |`,
    `| Bars | ${p.bars} from ${p.source} |`,
    `| Parquet | \`${p.parquetPath}\` |`,
    `| Algorithm | ${path.basename(path.resolve(path.dirname(p.parquetPath), "..", ".."))}${p.workspaceCreated ? " (workspace bootstrapped)" : ""} |`,
    "",
    `## Regime`,
    "",
    `**${regime.tag}** (${regime.confidence} confidence)`,
    `> ${regime.rationale}`,
    "",
    `## Price & Performance`,
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Return | ${perf.total_return_pct?.toFixed(2) ?? "?"}% |`,
    `| Ann. Volatility | ${perf.annualized_volatility_pct?.toFixed(2) ?? "?"}% |`,
    `| Max Drawdown | ${perf.max_drawdown_pct?.toFixed(2) ?? "?"}% |`,
    `| Price Range | ${price.low ?? "?"} – ${price.high ?? "?"} |`,
    `| Median | ${price.median ?? "?"} |`,
    `| P5 / P95 | ${price.p5 ?? "?"} / ${price.p95 ?? "?"} |`,
    "",
    `## Suggested Parameters`,
    "",
    `Use these as starting points — calibrate during backtest iteration.`,
    "",
    `| Parameter | Suggested Range | Rationale |`,
    `|-----------|----------------|-----------|`,
    `| Strategy type | ${s.strategy_type.join(", ")} | Best fit for ${regime.tag} regime |`,
    `| Bollinger width | ${s.bollinger_width} | Scaled to ${perf.annualized_volatility_pct?.toFixed(0) ?? "?"}% vol |`,
    `| Lookback | ${s.lookback_bars} | ${perf.annualized_volatility_pct > 50 ? "Shorter for faster reversion in high vol" : "Moderate for this vol level"} |`,
    `| Stop loss | ${s.stop_loss_pct} | From max DD (${perf.max_drawdown_pct?.toFixed(1) ?? "?"}%) and bar-level vol |`,
    `| Take profit | ${s.take_profit_pct} | 1.5–3× stop |`,
    `| Max hold | ${s.position_hold_bars} | ${regime.tag === "high-vol-chop" ? "Short holds to avoid whipsaws" : "Scaled to regime pace"} |`,
    "",
    `## Notes for Strategy Design`,
    "",
    ...s.notes.map(n => `- ${n}`),
    "",
    `## Data Quality`,
    "",
    `- Coverage: ${quality.coverage_pct ?? "?"}%`,
    `- Gaps: ${quality.gaps ?? 0} | OHLC violations: ${quality.ohlc_violations ?? 0} | Outliers: ${quality.outlier_bars ?? 0}`,
  ]

  if (quality.notes?.length) {
    lines.push(`- ${quality.notes.join("; ")}`)
  }

  lines.push("")
  return lines.join("\n")
}

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
    .refine((s) => !isNaN(Date.parse(s)), "Must be a valid date")
    .describe("Start date (inclusive) in YYYY-MM-DD format."),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .refine((s) => !isNaN(Date.parse(s)), "Must be a valid date")
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

        if (params.start >= params.end) {
          return {
            title: "Invalid date range",
            output: `start (${params.start}) must be before end (${params.end}).`,
            metadata: { error: "invalid_date_range" },
          }
        }

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
        let workspaceCreated = false
        let algoSlug: string | undefined
        if (!algoName) {
          // Active algo may already be a slug — use it as-is
          algoName = await getActiveAlgo() ?? undefined
        }
        if (!algoName) {
          algoName = `${slugifyAlgoName(resolved.canonical, params.interval)}-pending`
        }

        try {
          const ensured = await ensureAlgoWorkspace(algoName, { setActive: true })
          workspaceCreated = ensured.created
          algoSlug = ensured.slug
        } catch (e: any) {
          return {
            title: "Invalid algorithm name",
            output: `Could not prepare workspace for "${algoName}": ${e?.message ?? e}`,
            metadata: { error: "invalid_algo_name", algorithm: algoName },
          }
        }

        const algoPath = algoDir(algoSlug!)

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

          // ── Regime classification ──
          const regime = classifyRegime(digest)

          // ── Parameter suggestions based on stats ──
          const suggestions = deriveSuggestions(digest, params.interval, regime)

          // ── Write data_brief.md into algo workspace ──
          const briefPath = path.join(algoPath, "data_brief.md")
          const brief = buildDataBrief({
            symbol: resolved.canonical,
            interval: params.interval,
            start: params.start,
            end: params.end,
            bars: barsWritten,
            source: digest.source ?? "unknown",
            parquetPath,
            digest,
            regime,
            suggestions,
            workspaceCreated,
          })
          await fs.writeFile(briefPath, brief, "utf8")

          return {
            title: `${resolved.canonical} ${params.interval} — ${barsWritten} bars → ${path.basename(parquetPath)}`,
            output: brief,
            metadata: {
              symbol: resolved.canonical,
              interval: params.interval,
              bars: barsWritten,
              parquet_path: parquetPath,
              brief_path: briefPath,
              source: digest.source,
              algo: algoName,
              algo_slug: algoSlug,
              workspace_created: workspaceCreated,
              regime: regime.tag,
            },
          }
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        }
      }),
  }),
)
