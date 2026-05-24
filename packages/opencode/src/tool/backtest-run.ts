import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"

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

        const result = await BacktestRunner.run({
          algorithm: algo,
          duration: params.duration,
          interval: params.interval,
          capital: params.capital,
        })

        if (!result.ok) {
          return {
            title: "Backtest failed",
            output: `Backtest of "${params.algorithmName}" failed:\n${result.error}`,
            metadata: { ...emptyMeta },
          }
        }

        const r = result.results
        const fmt = (v: number, d = 2) => v.toFixed(d)
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
          if (d.buyAttempts === 0 && d.strategyErrors === 0) {
            lines.push(``,`LIKELY CAUSE: Entry conditions never triggered.`,`Thresholds may be too restrictive for this asset/regime.`)
          } else if (d.rejectedOrders > 0 && d.rejectedOrders === d.buyAttempts) {
            lines.push(``, `LIKELY CAUSE: All buy orders were rejected (${Object.keys(d.rejectionReasons).join(", ")}).`)
          } else if (d.strategyErrors > 0) {
            lines.push(``, `LIKELY CAUSE: Strategy raised ${d.strategyErrors} exceptions — the trading logic may be broken.`)
          }
          lines.push(`────────────────────────────────────────────────────`)
        }

        return {
          title: `Backtest: ${algo.name} (${params.duration}, ${params.interval})`,
          output: lines.join("\n"),
          metadata: {
            algorithmName: algo.name,
            params: {
              duration: params.duration,
              interval: params.interval,
              capital: params.capital,
            },
            // Omit v2 blob from metadata to keep session payload lean
            results: { ...r, v2: undefined },
          },
        }
      }),
  }),
)
