import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"
import { Validate } from "../algorithm/validate"

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
        "Examples: '5d' = 5 days, '2w' = 2 weeks, '1m' = 1 month, '3m' = 3 months, '1y' = 1 year. " +
        "Free-tier accounts are limited to ≤90 days; pro accounts can use any value.",
    ),
  interval: z
    .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
    .default("5min")
    .describe("Bar interval. Should match the algorithm's designed interval."),
  capital: z
    .string()
    .default("10000")
    .describe("Starting capital in USD (e.g. '10000')"),
})

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

        const algo = await Algorithm.get(params.algorithmName)
        if (!algo) {
          return {
            title: "Backtest failed",
            output: `Algorithm "${params.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
            metadata: { ...emptyMeta },
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
          robustness: { monteCarloPaths: 500, regimes: true },
        })

        if (!result.ok) {
          return {
            title: "Backtest failed",
            output: `Backtest of "${params.algorithmName}" failed:\n${result.error}`,
            metadata: { ...emptyMeta },
          }
        }

        const r = result.results
        const fmt = (v: number | null | undefined, d = 2) => v == null ? "N/A" : v.toFixed(d)
        const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`

        const lines = [
          `Algorithm: ${algo.name} (v${algo.version})`,
          `Duration: ${params.duration} | Interval: ${params.interval} | Capital: $${params.capital}`,
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
            lines.push(`│  Sample size         │  ${(`⚠ LOW (${r.totalTrades}/${minTrades} min)`).padStart(24)} │`)
          }
        }

        lines.push(`└──────────────────────┴───────────────────────────┘`)

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
          // Sizing check: if asset price is too high for the position size, math.floor(qty) = 0
          const capital = parseFloat(params.capital) || 10000
          if (d.priceFirst > 0) {
            const minPctForOneShare = (d.priceFirst / capital) * 100
            if (minPctForOneShare > 3) {
              lines.push(
                ``,
                `⚠ POSITION SIZING ISSUE: ${r.v2?.symbols?.[0] ?? "Asset"} trades at ~$${fmt(d.priceFirst, 0)}/share.`,
                `  With $${fmt(capital, 0)} capital, you need risk_pct ≥ ${fmt(minPctForOneShare, 1)}% to buy 1 share.`,
                `  If your strategy uses math.floor(qty) and risk_pct < ${fmt(minPctForOneShare, 1)}%, qty floors to 0 → zero trades.`,
                `  FIX: raise risk_pct, raise starting capital, or use fractional shares (qty = round(qty, 2)).`,
              )
            }
          }
          if (d.buyAttempts === 0 && d.strategyErrors === 0) {
            lines.push(``,`LIKELY CAUSE: Entry conditions never triggered, OR position size too small (see above).`,`Check risk_pct vs asset price — math.floor(qty) may be rounding to 0.`)
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
