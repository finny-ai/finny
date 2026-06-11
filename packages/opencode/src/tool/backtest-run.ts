import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"
import { Validate } from "../algorithm/validate"
import { normalizeInterval } from "../agent/request-identity"
import { evaluateBacktestQuality } from "../backtest/evaluation"

const parameters = z.object({
  algorithmName: z
    .string()
    .describe("Name of the saved algorithm to backtest (e.g. 'uco-intraday-hybrid')"),
  duration: z
    .string()
    .regex(/^\d+[dwmy]$/i, "Duration must match <number><unit> where unit is d/w/m/y (e.g. '5d', '2w', '1m', '1y')")
    .default("1m")
    .describe(
      "Backtest period as <number><unit> where unit is d (days), w (weeks), m (months), or y (years). " +
        "Examples: '5d' = 5 days, '2w' = 2 weeks, '1m' = 1 month, '3m' = 3 months, '1y' = 1 year.",
    ),
  interval: z
    .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
    .default("5min")
    .describe("Bar interval. Should match the algorithm's designed interval."),
  capital: z
    .string()
    .default("10000")
    .describe("Starting capital in USD (e.g. '10000')"),
  dataQualityMode: z
    .enum(["strict", "repair_outliers"])
    .default("strict")
    .describe("Strict by default. Use repair_outliers only when repairOutliersApproved is true after explicit user approval."),
  repairOutliersApproved: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY after the user explicitly approved a repair_outliers research rerun. Do not reuse interval-pivot or failure-budget approval.",
    ),
  userApproved: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY after the user explicitly approved continuing past two consecutive failed backtests for this symbol/interval. Renaming the algorithm does not reset the failure budget.",
    ),
})

type BacktestMessageLike = {
  parts?: Array<{
    type?: string
    tool?: string
    state?: {
      status?: string
      input?: Record<string, any>
      output?: string
      metadata?: Record<string, any>
    }
  }>
}

export type DataQualityFailureMetadata = {
  kind: "data_quality_failed"
  algorithmName: string
  params: { duration: string; interval: string; capital: string; dataQualityMode: "strict" | "repair_outliers" }
  phase?: "before_resample" | "after_resample"
  reason: string
  symbol?: string
  provider?: string
  interval?: string
  rawRows?: number
  postRows?: number
  coverage?: number
  gaps?: number
  duplicates?: number
  invalidOhlc?: number
  outliers?: number
  zeroVolume?: number
  repair_outliers_allowed: boolean
  outlierDetails: Array<{
    timestamp: string
    prev_close: number
    close: number
    log_return: number
    z_score: number
    provider?: string
  }>
}

/**
 * Count consecutive failed backtest runs that belong to the same attempt
 * stream. A prior run matches when it ran the SAME algorithm name, or — when
 * `scope` is known — the same symbol+interval under any name. The
 * symbol+interval match closes the rename loophole: saving the same concept
 * under a fresh algorithm name must not reset the failure budget.
 */
export function countConsecutiveFailedBacktests(
  messages: BacktestMessageLike[],
  algorithmName: string,
  scope?: { symbol?: string; interval?: string },
) {
  const scopeSymbol = scope?.symbol?.toUpperCase()
  const scopeInterval = scope?.interval && normalizeInterval(scope.interval)
  let count = 0
  for (const msg of [...messages].reverse()) {
    for (const part of [...(msg.parts ?? [])].reverse()) {
      if (part.type !== "tool" || part.tool !== "finny_backtest_run") continue
      if (part.state?.status !== "completed") continue

      const input = part.state.input
      const metadata = part.state.metadata
      const sameName = input?.algorithmName === algorithmName
      const partSymbol = (metadata?.results?.v2?.symbols?.[0] as string | undefined)?.toUpperCase()
      const partInterval = input?.interval && normalizeInterval(input.interval)
      const sameScope =
        Boolean(scopeSymbol && scopeInterval && partSymbol && partInterval) &&
        partSymbol === scopeSymbol &&
        partInterval === scopeInterval
      if (!sameName && !sameScope) continue

      const output = part.state.output ?? ""
      if (output.includes("Verdict: failed")) {
        count++
        continue
      }
      return count
    }
  }
  return count
}

export function repairOutliersBlockMessage(input: {
  dataQualityMode: "strict" | "repair_outliers"
  repairOutliersApproved?: boolean
}) {
  if (input.dataQualityMode !== "repair_outliers" || input.repairOutliersApproved === true) return undefined
  return (
    "Backtest blocked: repair_outliers mode requires explicit user approval for a research-only repaired-data rerun.\n\n" +
    "Run strict mode first. If strict data quality fails, stop and report the exact timestamp(s) and reason; do not repair automatically."
  )
}

export function strictDataQualityNextSteps() {
  return [
    "No performance metrics were produced; do not call this strategy backtested, ready, or paper/live eligible.",
    "Valid next steps:",
    "1. Verify the flagged candles first: inspect neighboring raw candles and compare another provider if available.",
    "2. Ask the user before changing the backtest window, interval, provider, or data-quality strictness.",
    "3. Only after explicit user approval, run repair_outliers as a research-only rerun.",
  ].join("\n")
}

function parseNumberField(text: string, field: string) {
  const match = text.match(new RegExp(`${field}=(-?\\d+(?:\\.\\d+)?)`))
  return match ? Number(match[1]) : undefined
}

function parseStringField(text: string, field: string) {
  const match = text.match(new RegExp(`${field}=([^,\\s)]+)`))
  return match?.[1]
}

export function parseDataQualityFailure(
  error: string,
  input: {
    algorithmName: string
    duration: string
    interval: string
    capital: string
    dataQualityMode: "strict" | "repair_outliers"
  },
): DataQualityFailureMetadata | undefined {
  if (!error.includes("__FINNY_OUTLIER__") && !error.includes("Data quality failed")) return undefined

  const phase = error.includes("Data quality failed before resample")
    ? "before_resample"
    : error.includes("Data quality failed after resample")
      ? "after_resample"
      : undefined
  const reason =
    error
      .split(/\r?\n/)
      .find((line) => line.includes("Data quality failed"))
      ?.trim() ?? "Strict data quality failed."

  const outlierDetails = [...error.matchAll(/__FINNY_OUTLIER__:\s+ts=(.*?)\s+prev_close=([^\s]+)\s+close=([^\s]+)\s+log_return=([^\s]+)\s+z=([^\s]+)\s+provider=([^\s]+)/g)].map(
    (match) => ({
      timestamp: match[1],
      prev_close: Number(match[2]),
      close: Number(match[3]),
      log_return: Number(match[4]),
      z_score: Number(match[5]),
      provider: match[6],
    }),
  )

  const reportLine = error
    .split(/\r?\n/)
    .find((line) => line.includes("provider=") && line.includes("symbol=") && line.includes("interval="))

  const provider = parseStringField(reportLine ?? "", "provider") ?? outlierDetails[0]?.provider

  return {
    kind: "data_quality_failed",
    algorithmName: input.algorithmName,
    params: input,
    phase,
    reason,
    symbol: parseStringField(reportLine ?? "", "symbol"),
    provider,
    interval: parseStringField(reportLine ?? "", "interval") ?? input.interval,
    rawRows: parseNumberField(reportLine ?? "", "raw_rows"),
    postRows: parseNumberField(reportLine ?? "", "post_rows"),
    coverage: parseNumberField(reportLine ?? "", "coverage"),
    gaps: parseNumberField(reportLine ?? "", "gaps"),
    duplicates: parseNumberField(reportLine ?? "", "duplicates"),
    invalidOhlc: parseNumberField(reportLine ?? "", "invalid_ohlc"),
    outliers: parseNumberField(reportLine ?? "", "outliers"),
    zeroVolume: parseNumberField(reportLine ?? "", "zero_volume"),
    repair_outliers_allowed: input.dataQualityMode === "repair_outliers",
    outlierDetails,
  }
}

export const BacktestRunTool = Tool.define(
  "finny_backtest_run",
  Effect.succeed({
    description:
      "Run a backtest on a saved algorithm. Returns performance metrics including total return, max drawdown, Sharpe ratio, win rate, profit factor, and more. Use this to evaluate strategy performance before suggesting changes or going live.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_backtest_run",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const emptyMeta = {
          algorithmName: undefined as string | undefined,
          params: undefined as { duration: string; interval: string; capital: string } | undefined,
          results: undefined as BacktestRunner.Results | undefined,
        }

        const repairBlock = repairOutliersBlockMessage(params)
        if (repairBlock) {
          return {
            title: "Backtest blocked by repair approval",
            output: repairBlock,
            metadata: { ...emptyMeta, repair_outliers_allowed: false },
          }
        }

        const algo = await Algorithm.get(params.algorithmName)
        if (!algo) {
          return {
            title: "Backtest failed",
            output: `Algorithm "${params.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
            metadata: { ...emptyMeta },
          }
        }

        // Failure budget is scoped to symbol+interval, not just the algorithm
        // name, so re-saving the same concept under a fresh name cannot reset
        // it. Only an explicit user approval (userApproved: true) continues
        // past the block.
        if (params.userApproved !== true) {
          const consecutiveFailures = countConsecutiveFailedBacktests(ctx.messages, params.algorithmName, {
            symbol: (algo.config as any)?.symbol,
            interval: params.interval,
          })
          if (consecutiveFailures >= 2) {
            return {
              title: "Backtest blocked by failure budget",
              output:
                `Backtest blocked: this symbol/interval already has ${consecutiveFailures} consecutive failed backtests in this session (latest: "${params.algorithmName}").\n\n` +
                `Renaming the algorithm does not reset this budget. Stop and summarize the blocker. ` +
                `If the user explicitly approves continuing (new concept, asset, timeframe, or venue), rerun with userApproved: true.`,
              metadata: { ...emptyMeta },
            }
          }
        }

        let riskBanner = ""
        try {
          const v = await Validate.run(algo.code, {
            config: algo.config,
          })
          if (!v.valid) {
            return {
              title: "Backtest blocked by validation",
              output: Validate.format(v),
              metadata: { ...emptyMeta },
            }
          }
          riskBanner = Validate.formatRiskBanner(v)
        } catch (e: any) {
          return {
            title: "Backtest blocked by validation",
            output: `Validation failed to run: ${e?.message ?? String(e)}`,
            metadata: { ...emptyMeta },
          }
        }

        const result = await BacktestRunner.run({
          algorithm: algo,
          duration: params.duration,
          interval: params.interval,
          capital: params.capital,
          dataQualityMode: params.dataQualityMode,
          robustness: { monteCarloPaths: 500, regimes: true },
        })

        if (!result.ok) {
          const dataQualityFailure = parseDataQualityFailure(result.error, {
            algorithmName: params.algorithmName,
            duration: params.duration,
            interval: params.interval,
            capital: params.capital,
            dataQualityMode: params.dataQualityMode,
          })
          if (dataQualityFailure) {
            const details = dataQualityFailure.outlierDetails
              .map(
                (d) =>
                  `outlier ts=${d.timestamp} prev_close=${d.prev_close} close=${d.close} log_return=${d.log_return} z=${d.z_score} provider=${d.provider ?? dataQualityFailure.provider ?? "unknown"}`,
              )
              .join("\n")
            return {
              title: "Backtest blocked by data quality",
              output:
                `Strict data quality blocked "${params.algorithmName}".\n` +
                `${dataQualityFailure.reason}\n` +
                (details ? `\n${details}\n` : "") +
                `\nStopped without running repair_outliers.\n\n${strictDataQualityNextSteps()}`,
              metadata: {
                ...emptyMeta,
                ...dataQualityFailure,
              },
            }
          }
          return {
            title: "Backtest failed",
            output: `Backtest of "${params.algorithmName}" failed:\n${result.error}`,
            metadata: { ...emptyMeta },
          }
        }

        const r = result.results
        const quality = evaluateBacktestQuality(r)
        const fmt = (v: number | null | undefined, d = 2) => v == null ? "N/A" : v.toFixed(d)
        const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`

        const lines = [
          `Algorithm: ${algo.name} (v${algo.version})`,
          `Duration: ${params.duration} | Interval: ${params.interval} | Capital: $${params.capital}`,
          params.dataQualityMode === "repair_outliers" ? `Data quality mode: REPAIRED DATA BACKTEST (research-only)` : `Data quality mode: strict`,
          ``,
          `┌──────────────────────────────────────────────────┐`,
          `│  BACKTEST RESULTS                                │`,
          `├──────────────────────┬───────────────────────────┤`,
          `│  Total Return        │  ${fmtPct(r.totalReturn).padStart(24)} │`,
          `│  Ending Equity       │  ${("$" + fmt(r.endingEquity)).padStart(24)} │`,
          `│  Max Drawdown        │  ${fmtPct(r.maxDrawdown).padStart(24)} │`,
          `│  Sharpe Ratio        │  ${fmt(r.sharpeRatio).padStart(24)} │`,
          `│  Total Trades        │  ${String(r.totalTrades).padStart(24)} │`,
          `│  Win Rate            │  ${fmtPct(r.winRate).padStart(24)} │`,
          `│  Profit Factor       │  ${fmt(r.profitFactor).padStart(24)} │`,
          `│  Ann. Volatility     │  ${fmtPct(r.annualizedVolatility).padStart(24)} │`,
        ]

        if (r.sortino !== undefined && r.totalTrades > 0) {
          lines.push(
            `├──────────────────────┼───────────────────────────┤`,
            `│  Sortino Ratio       │  ${fmt(r.sortino).padStart(24)} │`,
            `│  Calmar Ratio        │  ${fmt(r.calmar ?? 0).padStart(24)} │`,
            `│  VaR (95%)           │  ${fmtPct(r.var95 ?? 0).padStart(24)} │`,
            `│  CVaR (95%)          │  ${fmtPct(r.cvar95 ?? 0).padStart(24)} │`,
            `│  Max DD Duration     │  ${(String(r.maxDdDuration ?? 0) + " bars").padStart(24)} │`,
            `│  Time in Market      │  ${fmtPct(r.timeInMarket ?? 0).padStart(24)} │`,
          )
        }

        // Trade significance — surface t-stat, p-value, and dynamic low_sample
        const tradeBlock = r.v2?.trade
        if (tradeBlock && r.totalTrades > 0) {
          const tstat = tradeBlock.trade_tstat
          const pval = tradeBlock.trade_pvalue
          const barCount = r.diagnostics?.barsProcessed ?? r.v2?.bars_processed ?? 0
          const minTrades = Math.max(3, Math.min(30, Math.floor(barCount * 0.01)))
          const lowSample = r.totalTrades < minTrades
          lines.push(
            `├──────────────────────┼───────────────────────────┤`,
          )
          if (tstat != null) {
            lines.push(`│  Trade t-stat        │  ${fmt(tstat, 3).padStart(24)} │`)
          }
          if (pval != null) {
            const sig = pval < 0.01 ? "***" : pval < 0.05 ? "**" : pval < 0.10 ? "*" : ""
            lines.push(`│  Trade p-value       │  ${(fmt(pval, 4) + " " + sig).padStart(24)} │`)
          }
          if (lowSample) {
            lines.push(`│  Sample size         │  ${(`⚠ LOW (${r.totalTrades} trades)`).padStart(24)} │`)
          }
        }

        lines.push(`└──────────────────────┴───────────────────────────┘`)

        lines.push(
          ``,
          `── QUALITY GATE ───────────────────────────────────`,
          `Verdict: ${quality.label}`,
        )
        if (r.totalReturn > 0 && !quality.paperEligible) {
          lines.push(`Positive ROI, but NOT paper eligible.`)
        }
        if (quality.reasons.length > 0) {
          lines.push(`Reasons: ${quality.reasons.join("; ")}`)
        }
        if (r.totalTrades > 0 && r.totalTrades < quality.minTrades) {
          lines.push(
            `Trade count is low for this window (${r.totalTrades} trades) — confidence is limited; ` +
            `interpret Sharpe/win rate cautiously. This is a caveat, not an automatic failure.`,
          )
        }
        if (r.v2?.data_quality?.repair_applied) {
          lines.push(`REPAIRED DATA BACKTEST — research-only until rerun on strict clean data.`)
        }
        lines.push(`────────────────────────────────────────────────────`)

        if (r.totalTrades === 0 && r.diagnostics) {
          const d = r.diagnostics
          lines.push(
            ``,
            `── ZERO-TRADE DIAGNOSTICS ──────────────────────────`,
            `Bars processed:  ${d.barsProcessed}`,
            `Buy attempts:    ${d.buyAttempts}  |  Sell attempts: ${d.sellAttempts}`,
            `Rejected orders: ${d.rejectedOrders}`,
          )
          if (Object.keys(d.rejectionReasons).length > 0) {
            lines.push(`Rejection reasons:`)
            for (const [reason, count] of Object.entries(d.rejectionReasons)) {
              lines.push(`  • ${reason}: ${count}`)
            }
          }
          if (d.priceFirst > 0) {
            lines.push(`Price range:     $${fmt(d.priceFirst)} → $${fmt(d.priceLast)} (${fmtPct(d.priceRangePct)} range)`)
          }
          if (d.strategyErrors > 0) {
            lines.push(`Strategy errors: ${d.strategyErrors} (check stderr for details)`)
          }
          // Sizing check: when the share price is large relative to capital,
          // floor(qty) can round to 0. HOW small qty gets depends on the sizing
          // pattern, so we describe both rather than prescribing a single
          // risk_pct threshold (which only applies to allocation sizing).
          const capital = parseFloat(params.capital) || 10000
          if (d.priceFirst > 0) {
            const minPctForOneShare = (d.priceFirst / capital) * 100
            if (minPctForOneShare > 3) {
              const sym = r.v2?.symbols?.[0] ?? "Asset"
              lines.push(
                ``,
                `⚠ POSITION SIZING CHECK: ${sym} trades at ~$${fmt(d.priceFirst, 0)}/share against $${fmt(capital, 0)} capital.`,
                `  • Allocation sizing (qty = equity × alloc_pct / price): you need alloc_pct ≥ ${fmt(minPctForOneShare, 1)}% just to afford 1 share.`,
                `  • Risk-based sizing (qty = equity × risk_pct / stop_dist, then cash-capped): whether floor(qty)=0`,
                `    depends on the STOP DISTANCE, not just price. A tight stop_pct needs a far smaller risk_pct than ${fmt(minPctForOneShare, 1)}%`,
                `    to reach 1 share — but a very small risk_pct still floors to 0.`,
                `  Inspect the computed qty before AND after the cash cap. FIX: raise the sizing %, widen the stop,`,
                `  raise starting capital, or use fractional shares (qty = round(qty, 2)) where supported.`,
              )
            }
          }
          if (d.buyAttempts === 0 && d.strategyErrors === 0) {
            lines.push(``,`LIKELY CAUSE: Entry conditions never triggered, OR position size too small (see above).`,`Check the computed qty against the asset price/stop distance — math.floor(qty) may be rounding to 0.`)
          } else if (d.rejectedOrders > 0 && d.rejectedOrders === d.buyAttempts) {
            lines.push(``, `LIKELY CAUSE: All buy orders were rejected (${Object.keys(d.rejectionReasons).join(", ")}).`)
          } else if (d.strategyErrors > 0) {
            lines.push(``, `LIKELY CAUSE: Strategy raised ${d.strategyErrors} exceptions — the trading logic may be broken.`)
          }
          lines.push(`────────────────────────────────────────────────────`)
        }

        // Engine + assumptions footer — surfaces fill model, fee/slippage
        // assumptions, kill-switch trips, and parse-warning fallout so
        // consumers don't silently miss them.
        if (r.engineVersion || r.diagnostics?.assumptions) {
          lines.push(``, `── ENGINE & ASSUMPTIONS ────────────────────────────`)
          if (r.engineVersion) lines.push(`Engine: ${r.engineVersion} (schema_version=${r.schemaVersion ?? "?"})`)
          if (r.runId) lines.push(`Run ID: ${r.runId}`)
          if (r.artifactDir) lines.push(`Artifacts: ${r.artifactDir}`)
          if (r.eligibilityStatus) lines.push(`Eligibility: ${r.eligibilityStatus}`)
          if (r.diagnostics?.assumptions) {
            const a = r.diagnostics.assumptions
            const fee = a.taker_fee_bps != null ? `${a.taker_fee_bps.toFixed(2)} bps taker` : `${(((a.fee_rate ?? 0) * 100).toFixed(3))}%`
            const slip = a.slippage_bps != null ? `${a.slippage_bps.toFixed(2)} bps + ATR/volume impact` : `${(((a.slippage ?? 0) * 100).toFixed(3))}%`
            lines.push(`Fill model: ${a.fill_model}  |  fee=${fee}  |  slippage=${slip}`)
            if (a.participation_cap_pct != null) {
              lines.push(`Participation cap: ${a.participation_cap_pct.toFixed(1)}% of bar volume (binding)`)
            }
          }
          if (r.diagnostics?.participationWarningCount && r.diagnostics.participationWarningCount > 0) {
            lines.push(`[!] ${r.diagnostics.participationWarningCount} fills exceeded participation cap — review diagnostics`)
          }
          if (r.diagnostics?.killed) {
            const k = r.diagnostics.killed
            lines.push(`[!] KILL SWITCH TRIPPED — ${k.reason}` + (k.equity !== undefined ? ` (equity=${k.equity.toFixed(2)}, threshold=${(k.threshold ?? 0).toFixed(2)})` : ""))
          }
          if (r.diagnostics?.pendingOrdersAtEnd && r.diagnostics.pendingOrdersAtEnd > 0) {
            lines.push(`${r.diagnostics.pendingOrdersAtEnd} order(s) remained pending at end of window (placed on the last bar, never filled).`)
          }
          if (r.diagnostics?.sharpeUndefinedReason) {
            lines.push(`Sharpe undefined — reason: ${r.diagnostics.sharpeUndefinedReason}`)
          }
          if (r.diagnostics?.parseWarnings && r.diagnostics.parseWarnings.length > 0) {
            lines.push(`Parse warnings: ${r.diagnostics.parseWarnings.join(", ")}`)
          }
          lines.push(`────────────────────────────────────────────────────`)
        }

        const finalOutput = riskBanner
          ? `${riskBanner}\n\n${lines.join("\n")}`
          : lines.join("\n")

        return {
          title: `Backtest: ${algo.name} (${params.duration}, ${params.interval})`,
          output: finalOutput,
          metadata: {
            algorithmName: algo.name,
            params: {
              duration: params.duration,
              interval: params.interval,
              capital: params.capital,
            },
            results: { ...r, v2: undefined },
          },
        }
      }),
  }),
)
