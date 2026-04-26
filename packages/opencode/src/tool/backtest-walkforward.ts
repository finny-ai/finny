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
    .regex(/^\d+[dwmy]$/i, "Duration must match <number><unit> where unit is d/w/m/y (e.g. '3m', '6m')")
    .default("3m")
    .describe(
      "TOTAL window to split. The first part (in-sample) is used to assess the strategy's " +
        "performance on the data the model was effectively designed against; the second part " +
        "(out-of-sample) is held out and used to detect overfitting. Recommend ≥3m so each half has enough trades.",
    ),
  interval: z
    .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
    .default("5min")
    .describe("Bar interval. Should match the algorithm's designed interval."),
  capital: z.string().default("10000").describe("Starting capital in USD"),
  splitRatio: z
    .number()
    .min(0.5)
    .max(0.9)
    .default(0.7)
    .describe("Fraction of the window used as in-sample. Default 0.7 → 70% IS / 30% OOS."),
})

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export const BacktestWalkforwardTool = Tool.define(
  "finny_backtest_walkforward",
  Effect.succeed({
    description:
      "Run a walk-forward backtest: splits the duration window into in-sample (first 70%) and " +
      "out-of-sample (last 30%), runs the algorithm on each independently, and reports both metric " +
      "sets plus a robustness verdict. The strategy is OVERFIT if out-of-sample Sharpe is far below " +
      "in-sample Sharpe or if out-of-sample loses money. Use this as the primary overfitting gate " +
      "before declaring a strategy 'good'.",
    parameters,
    execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_backtest_walkforward",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const algo = await Algorithm.get(input.algorithmName)
        if (!algo) {
          return {
            title: "Walk-forward failed",
            output: `Algorithm "${input.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
            metadata: {},
          }
        }

        const totalDays = BacktestRunner.parseDurationDays(input.duration)
        if (!totalDays || totalDays < 14) {
          return {
            title: "Walk-forward failed",
            output:
              `Duration "${input.duration}" is too short for a walk-forward split. ` +
              `Use at least 2w (14 days) so each half has enough bars; 3m or longer is recommended.`,
            metadata: {},
          }
        }

        const end = new Date()
        const start = new Date()
        start.setDate(start.getDate() - totalDays)

        const isDays = Math.max(1, Math.floor(totalDays * input.splitRatio))
        const splitDate = new Date(start)
        splitDate.setDate(splitDate.getDate() + isDays)

        const isResult = await BacktestRunner.run({
          algorithm: algo,
          duration: input.duration,
          interval: input.interval,
          capital: input.capital,
          startDate: fmt(start),
          endDate: fmt(splitDate),
        })

        if (!isResult.ok) {
          return {
            title: "Walk-forward failed (in-sample)",
            output: `In-sample backtest failed:\n${isResult.error}`,
            metadata: {},
          }
        }

        const oosResult = await BacktestRunner.run({
          algorithm: algo,
          duration: input.duration,
          interval: input.interval,
          capital: input.capital,
          startDate: fmt(splitDate),
          endDate: fmt(end),
        })

        if (!oosResult.ok) {
          return {
            title: "Walk-forward failed (out-of-sample)",
            output: `Out-of-sample backtest failed:\n${oosResult.error}`,
            metadata: {},
          }
        }

        const is = isResult.results
        const oos = oosResult.results

        const sharpeRatio = is.sharpeRatio !== 0 ? oos.sharpeRatio / is.sharpeRatio : 0
        let verdict: "robust" | "degraded" | "failed"
        let verdictReason: string
        if (oos.totalReturn <= 0 || oos.sharpeRatio <= 0) {
          verdict = "failed"
          verdictReason = "Out-of-sample lost money or had non-positive Sharpe — the strategy does not generalize."
        } else if (is.sharpeRatio > 0 && sharpeRatio < 0.7) {
          verdict = "degraded"
          verdictReason = `Out-of-sample Sharpe is ${(sharpeRatio * 100).toFixed(0)}% of in-sample — significant performance drop suggests overfitting.`
        } else {
          verdict = "robust"
          verdictReason = "Out-of-sample performance is within 30% of in-sample. Strategy generalizes."
        }

        const lines = [
          `Algorithm: ${algo.name} (v${algo.version})`,
          `Total window: ${input.duration} (${fmt(start)} → ${fmt(end)})`,
          `Split: ${(input.splitRatio * 100).toFixed(0)}% IS (${fmt(start)} → ${fmt(splitDate)}) / ${((1 - input.splitRatio) * 100).toFixed(0)}% OOS (${fmt(splitDate)} → ${fmt(end)})`,
          ``,
          `                       In-Sample      Out-of-Sample`,
          `Total Return:          ${(is.totalReturn * 100).toFixed(2).padStart(8)}%      ${(oos.totalReturn * 100).toFixed(2).padStart(8)}%`,
          `Max Drawdown:          ${(is.maxDrawdown * 100).toFixed(2).padStart(8)}%      ${(oos.maxDrawdown * 100).toFixed(2).padStart(8)}%`,
          `Sharpe Ratio:          ${is.sharpeRatio.toFixed(2).padStart(8)}       ${oos.sharpeRatio.toFixed(2).padStart(8)}`,
          `Total Trades:          ${String(is.totalTrades).padStart(8)}       ${String(oos.totalTrades).padStart(8)}`,
          `Win Rate:              ${(is.winRate * 100).toFixed(1).padStart(7)}%       ${(oos.winRate * 100).toFixed(1).padStart(7)}%`,
          `Profit Factor:         ${is.profitFactor.toFixed(2).padStart(8)}       ${oos.profitFactor.toFixed(2).padStart(8)}`,
          ``,
          `Robustness ratio (OOS Sharpe / IS Sharpe): ${sharpeRatio.toFixed(2)}`,
          `Verdict: ${verdict.toUpperCase()} — ${verdictReason}`,
        ]

        return {
          title: `Walk-forward: ${algo.name} (${verdict})`,
          output: lines.join("\n"),
          metadata: {},
        }
      }),
  }),
)
