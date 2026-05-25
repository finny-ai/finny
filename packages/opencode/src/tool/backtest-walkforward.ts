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

        type WfMeta = {
          walkForward?: {
            n_folds: number
            is_sharpe_mean: number
            oos_sharpe_mean: number
            oos_decay: number
            flag_threshold: number
            flagged: boolean
            deflated_sharpe: number
            probabilistic_sharpe: number
            folds: Array<{
              fold: number
              train_start: string
              train_end: string
              test_start: string
              test_end: string
              is_sharpe: number
              oos_sharpe: number
              is_return: number
              oos_return: number
            }>
          }
          engineVersion?: string
          schemaVersion?: number
        }
        const EMPTY_META: WfMeta = {}

        const algo = await Algorithm.get(input.algorithmName)
        if (!algo) {
          return {
            title: "Walk-forward failed",
            output: `Algorithm "${input.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
            metadata: EMPTY_META,
          }
        }

        const validation = await Validate.run(algo.code, { config: algo.config })
        if (!validation.valid) {
          return {
            title: "Walk-forward blocked by validation",
            output: Validate.format(validation),
            metadata: EMPTY_META,
          }
        }
        const riskBanner = Validate.formatRiskBanner(validation)

        const totalDays = BacktestRunner.parseDurationDays(input.duration)
        if (!totalDays || totalDays < 14) {
          return {
            title: "Walk-forward failed",
            output:
              `Duration "${input.duration}" is too short for a walk-forward split. ` +
              `Use at least 2w (14 days) so each half has enough bars; 3m or longer is recommended.`,
            metadata: EMPTY_META,
          }
        }

        const now = new Date()
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        const start = new Date(end)
        start.setUTCDate(start.getUTCDate() - totalDays)

        const result = await BacktestRunner.run({
          algorithm: algo,
          duration: input.duration,
          interval: input.interval,
          capital: input.capital,
          startDate: fmt(start),
          endDate: fmt(end),
          robustness: { monteCarloPaths: 0, regimes: true, walkForwardFolds: 5 },
        })

        if (!result.ok) {
          return {
            title: "Walk-forward failed",
            output: `Backtest failed:\n${result.error}`,
            metadata: EMPTY_META,
          }
        }

        const walkForward = result.results.v2?.walk_forward
        if (!walkForward || walkForward.n_folds < 2) {
          return {
            title: "Walk-forward failed",
            output: "Strict engine did not produce enough walk-forward folds. Use a longer duration or coarser interval.",
            metadata: EMPTY_META,
          }
        }

        let verdict: "robust" | "degraded" | "failed"
        let verdictReason: string
        if (walkForward.flagged || walkForward.oos_sharpe_mean <= 0) {
          verdict = "failed"
          verdictReason = "Walk-forward OOS Sharpe decayed below the robustness threshold or became non-positive."
        } else if (walkForward.oos_decay < 0.7) {
          verdict = "degraded"
          verdictReason = `OOS Sharpe retained ${(walkForward.oos_decay * 100).toFixed(0)}% of in-sample performance — meaningful decay.`
        } else {
          verdict = "robust"
          verdictReason = "Rolling OOS performance is within the robustness threshold."
        }

        const lines = [
          `Algorithm: ${algo.name} (v${algo.version})`,
          `Total window: ${input.duration} (${fmt(start)} → ${fmt(end)})`,
          `Rolling folds: ${walkForward.n_folds} | Train split: ${(input.splitRatio * 100).toFixed(0)}% per fold`,
          ``,
          `IS Sharpe mean:        ${walkForward.is_sharpe_mean.toFixed(2)}`,
          `OOS Sharpe mean:       ${walkForward.oos_sharpe_mean.toFixed(2)}`,
          `OOS decay ratio:       ${walkForward.oos_decay.toFixed(2)}`,
          `Deflated Sharpe prob:  ${walkForward.deflated_sharpe.toFixed(3)}`,
          `Prob. Sharpe ratio:    ${walkForward.probabilistic_sharpe.toFixed(3)}`,
          ``,
          `fold\ttrain\ttest\tIS Sharpe\tOOS Sharpe\tOOS Return`,
          ...walkForward.folds.map(f =>
            `${f.fold}\t${f.train_start.slice(0, 10)}→${f.train_end.slice(0, 10)}\t${f.test_start.slice(0, 10)}→${f.test_end.slice(0, 10)}\t${f.is_sharpe.toFixed(2)}\t${f.oos_sharpe.toFixed(2)}\t${(f.oos_return * 100).toFixed(2)}%`,
          ),
          ``,
          `Verdict: ${verdict.toUpperCase()} — ${verdictReason}`,
        ]

        const finalOutput = riskBanner ? `${riskBanner}\n\n${lines.join("\n")}` : lines.join("\n")
        return {
          title: `Walk-forward: ${algo.name} (${verdict})`,
          output: finalOutput,
          metadata: { walkForward, engineVersion: result.results.engineVersion, schemaVersion: result.results.schemaVersion },
        }
      }),
  }),
)
