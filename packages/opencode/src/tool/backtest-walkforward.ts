import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"
import { Validate } from "../algorithm/validate"
import { requireVerifiedDataExtractorEvidenceForSession } from "../data/data-extractor-evidence"

const parameters = z.object({
  algorithmName: z
    .string()
    .describe("Name of the saved algorithm to backtest (e.g. 'uco-intraday-hybrid')"),
  duration: z
    .string()
    .regex(/^\d+[dwmy]$/i, "Duration must match <number><unit> where unit is d/w/m/y (e.g. '3m', '6m')")
    .default("3m")
    .describe(
      "Total rolling walk-forward window. Recommend ≥3m so each fold has enough bars.",
    ),
  interval: z
    .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
    .default("5min")
    .describe("Bar interval. Should match the algorithm's designed interval."),
  capital: z.string().default("10000").describe("Starting capital in USD"),
})

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "N/A"
}

type WfMeta = {
  walkForward?: {
    n_folds: number
    is_sharpe_mean: number
    oos_sharpe_mean: number
    oos_decay: number
    is_to_oos_sharpe_change?: number
    flag_threshold: number
    flagged: boolean
    deflated_sharpe: number | null
    probabilistic_sharpe: number | null
    stitched_oos_return?: number
    stitched_oos_sharpe?: number
    stitched_oos_trades?: number
    stitched_oos_bars?: number
    stitched_oos_coverage?: number
    ruined_folds?: number
    multiple_testing_trials?: number
    folds: Array<{
      fold: number
      train_start: string
      train_end: string
      test_start: string
      test_end: string
      is_sharpe: number | null
      oos_sharpe: number | null
      is_return: number
      oos_return: number
      oos_trades?: number
      oos_coverage?: number
      ruined?: boolean
    }>
  }
  engineVersion?: string
  schemaVersion?: number
}

const EMPTY_META: WfMeta = {}

export function formatWalkForwardLines(input: {
  algorithmName: string
  version: number
  duration: string
  start: string
  end: string
  walkForward: NonNullable<WfMeta["walkForward"]>
  verdict: string
  verdictReason: string
}): string[] {
  const walkForward = input.walkForward
  return [
    `Algorithm: ${input.algorithmName} (v${input.version})`,
    `Total window: ${input.duration} (${input.start} → ${input.end})`,
    `Rolling out-of-sample folds: ${walkForward.n_folds}`,
    ``,
    `IS Sharpe mean:        ${fmtNum(walkForward.is_sharpe_mean)}`,
    `OOS Sharpe mean:       ${fmtNum(walkForward.oos_sharpe_mean)}`,
    `IS→OOS Sharpe change:  ${fmtNum(walkForward.is_to_oos_sharpe_change ?? (walkForward.oos_sharpe_mean - walkForward.is_sharpe_mean))}`,
    `OOS decay ratio:       ${fmtNum(walkForward.oos_decay)}`,
    `Stitched OOS return:   ${fmtNum((walkForward.stitched_oos_return ?? 0) * 100)}%`,
    `Stitched OOS Sharpe:   ${fmtNum(walkForward.stitched_oos_sharpe ?? walkForward.oos_sharpe_mean)}`,
    `Stitched OOS trades:   ${walkForward.stitched_oos_trades ?? "N/A"}`,
    `OOS coverage:          ${fmtNum((walkForward.stitched_oos_coverage ?? 0) * 100)}%`,
    `Ruined folds:          ${walkForward.ruined_folds ?? 0}`,
    `Multiple-test trials:  ${walkForward.multiple_testing_trials ?? 1}`,
    `Deflated Sharpe prob:  ${fmtNum(walkForward.deflated_sharpe, 3)}`,
    `Prob. Sharpe ratio:    ${fmtNum(walkForward.probabilistic_sharpe, 3)}`,
    ``,
    `fold\ttrain\ttest\tIS Sharpe\tOOS Sharpe\tOOS Return\tOOS Trades\tCoverage\tRuined`,
    ...walkForward.folds.map(f =>
      `${f.fold}\t${f.train_start.slice(0, 10)}→${f.train_end.slice(0, 10)}\t${f.test_start.slice(0, 10)}→${f.test_end.slice(0, 10)}\t${fmtNum(f.is_sharpe)}\t${fmtNum(f.oos_sharpe)}\t${(f.oos_return * 100).toFixed(2)}%\t${f.oos_trades ?? "N/A"}\t${fmtNum((f.oos_coverage ?? 0) * 100)}%\t${f.ruined ? "yes" : "no"}`,
    ),
    ``,
    `Verdict: ${input.verdict.toUpperCase()} — ${input.verdictReason}`,
  ]
}

export const BacktestWalkforwardTool = Tool.define(
  "finny_backtest_walkforward",
  Effect.succeed({
    description:
      "Run a rolling walk-forward backtest across the requested duration and report the in-sample and out-of-sample metric " +
      "sets plus a robustness verdict. The strategy is OVERFIT if out-of-sample Sharpe is far below " +
      "in-sample Sharpe or if out-of-sample loses money. Use this as the primary overfitting gate " +
      "before declaring a strategy 'good'.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_backtest_walkforward",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const evidence = await requireVerifiedDataExtractorEvidenceForSession(ctx.sessionID)
        if (!evidence.ok) {
          return {
            title: "Walk-forward blocked by missing evidence",
            output: evidence.text,
            metadata: {
              ...EMPTY_META,
              blocked: true,
              evidenceRequired: true,
              workspaceSlug: evidence.workspaceSlug,
              issues: evidence.issues,
            },
          }
        }

        const algo = await Algorithm.get(params.algorithmName)
        if (!algo) {
          return {
            title: "Walk-forward failed",
            output: `Algorithm "${params.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
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

        const totalDays = BacktestRunner.parseDurationDays(params.duration)
        if (!totalDays || totalDays < 14) {
          return {
            title: "Walk-forward failed",
            output:
              `Duration "${params.duration}" is too short for a walk-forward split. ` +
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
          duration: params.duration,
          interval: params.interval,
          capital: params.capital,
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
        if (walkForward.flagged || (walkForward.stitched_oos_sharpe ?? walkForward.oos_sharpe_mean) <= 0 || (walkForward.stitched_oos_return ?? 0) <= 0) {
          verdict = "failed"
          verdictReason = "Rolling OOS Sharpe decayed below the robustness threshold or stitched OOS performance became non-positive."
        } else if (walkForward.oos_decay < 0.7) {
          verdict = "degraded"
          verdictReason = `OOS Sharpe retained ${(walkForward.oos_decay * 100).toFixed(0)}% of in-sample performance — meaningful decay.`
        } else {
          verdict = "robust"
          verdictReason = "Rolling OOS performance is within the robustness threshold."
        }

        const lines = formatWalkForwardLines({
          algorithmName: algo.name,
          version: algo.version,
          duration: params.duration,
          start: fmt(start),
          end: fmt(end),
          walkForward,
          verdict,
          verdictReason,
        })

        const finalOutput = riskBanner ? `${riskBanner}\n\n${lines.join("\n")}` : lines.join("\n")
        return {
          title: `Walk-forward: ${algo.name} (${verdict})`,
          output: finalOutput,
          metadata: { walkForward, engineVersion: result.results.engineVersion, schemaVersion: result.results.schemaVersion },
        }
      }),
  }),
)
