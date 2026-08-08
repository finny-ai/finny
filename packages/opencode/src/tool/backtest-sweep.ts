import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"
import { Validate } from "../algorithm/validate"

const MAX_COMBOS = 27

export const BacktestSweepParameters = z.object({
  algorithmName: z
    .string()
    .describe("Name of the saved algorithm to backtest"),
  paramGrid: z
    .record(z.string(), z.array(z.union([z.number(), z.string(), z.boolean()])))
    .describe(
      "Parameter grid: object mapping param name to a list of values to try. " +
        "The Cartesian product is run as separate backtests. Example: " +
        '{ "rsi_period": [10, 14, 18], "oversold": [25, 30, 35] } → 9 backtests. ' +
        "Total combinations are capped at " + MAX_COMBOS + ". " +
        "IMPORTANT: the strategy must read these from `params` in its __init__ " +
        "(i.e. `def __init__(self, broker, params=None)` and `params.get('rsi_period', 14)`). " +
        "Strategies that hardcode constants will return identical metrics for every combo " +
        "and the sweep is meaningless.",
    ),
  duration: z
    .string()
    .regex(/^\d+[dwmy]$/i)
    .default("3m")
    .describe("Backtest period for each combo. Same format as finny_backtest."),
  interval: z
    .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
    .default("1h")
    .describe("Bar interval"),
  capital: z.string().default("10000").describe("Starting capital in USD"),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Exact confirmed sweep start date YYYY-MM-DD."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Exact confirmed sweep end date YYYY-MM-DD."),
  walkForwardFolds: z
    .number()
    .int()
    .min(2)
    .default(10)
    .describe("Number of rolling walk-forward folds to run for each parameter combination. Defaults to 10; use any integer of at least 2."),
  feeBps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Optional taker fee in basis points for each run. Overrides the saved execution fee without changing the algorithm."),
  slippageBps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Optional base slippage in basis points for each run. Overrides the saved execution slippage without changing the algorithm."),
}).refine((input) => Boolean(input.startDate) === Boolean(input.endDate), {
  message: "startDate and endDate must be supplied together to preserve the exact sweep window",
  path: ["startDate"],
})

type Combo = Record<string, number | string | boolean>

function cartesian(grid: Record<string, (number | string | boolean)[]>): Combo[] {
  const keys = Object.keys(grid)
  if (keys.length === 0) return [{}]
  let result: Combo[] = [{}]
  for (const k of keys) {
    const next: Combo[] = []
    for (const partial of result) {
      for (const v of grid[k]) {
        next.push({ ...partial, [k]: v })
      }
    }
    result = next
  }
  return result
}

function fmtParams(p: Combo): string {
  return Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
}

function nestedOosScore(metrics: BacktestRunner.Results): { sharpe: number; ret: number; trades: number } {
  const wf = metrics.v2?.walk_forward
  return {
    sharpe: Number.isFinite(wf?.stitched_oos_sharpe) ? Number(wf?.stitched_oos_sharpe) : Number(wf?.oos_sharpe_mean ?? metrics.sharpeRatio),
    ret: Number.isFinite(wf?.stitched_oos_return) ? Number(wf?.stitched_oos_return) : metrics.totalReturn,
    trades: Number.isFinite(wf?.stitched_oos_trades) ? Number(wf?.stitched_oos_trades) : metrics.totalTrades,
  }
}

export const BacktestSweepTool = Tool.define(
  "finny_backtest_sweep",
  Effect.succeed({
    description:
      "Run a parameter sweep: backtests every combination from the supplied param grid and reports " +
      "a performance matrix plus sensitivity analysis. Use this to detect parameter overfitting — " +
      "a robust strategy performs similarly across nearby parameter values; a fragile strategy has " +
      "wildly different metrics for small changes. Cap of " + MAX_COMBOS + " total combinations. " +
      "Crucible collects and strictly validates its own market data; Data Agent artifacts are not required or consumed. " +
      "The strategy MUST accept a `params` kwarg in its constructor and read values from it; " +
      "otherwise every combo runs identical code and the sweep is meaningless.",
    parameters: BacktestSweepParameters,
    execute: (input: z.infer<typeof BacktestSweepParameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_backtest_sweep",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const algo = await Algorithm.get(input.algorithmName)
        if (!algo) {
          return {
            title: "Sweep failed",
            output: `Algorithm "${input.algorithmName}" not found.`,
            metadata: {},
          }
        }

        if (!algo.code.includes("params")) {
          return {
            title: "Sweep aborted — strategy does not read params",
            output:
              `Algorithm "${algo.name}" never references "params" in its code, which means the ` +
              `sweep would run identical strategy code for every combination and produce useless results.\n\n` +
              `Rewrite the strategy to use the params convention:\n\n` +
              `    class Strategy:\n` +
              `        def __init__(self, broker, params=None):\n` +
              `            self.broker = broker\n` +
              `            p = params or {}\n` +
              `            self.rsi_period = int(p.get("rsi_period", 14))\n` +
              `            # ...read every param from p\n\n` +
              `Then save the updated algorithm and re-run the sweep.`,
            metadata: {},
          }
        }

        const validation = await Validate.run(algo.code, { config: algo.config })
        if (!validation.valid) {
          return {
            title: "Sweep blocked by validation",
            output: Validate.format(validation),
            metadata: {},
          }
        }

        const combos = cartesian(input.paramGrid)
        if (combos.length === 0) {
          return {
            title: "Sweep failed",
            output: "Empty paramGrid — provide at least one param with at least one value.",
            metadata: {},
          }
        }
        if (combos.length > MAX_COMBOS) {
          return {
            title: "Sweep failed",
            output: `Grid produces ${combos.length} combinations, exceeding the cap of ${MAX_COMBOS}. Narrow the grid.`,
            metadata: {},
          }
        }

        const results: Array<{
          params: Combo
          ok: boolean
          metrics?: BacktestRunner.Results
          error?: string
        }> = []

        for (const combo of combos) {
          const r = await BacktestRunner.run({
            algorithm: algo,
            duration: input.duration,
            interval: input.interval,
            capital: input.capital,
            startDate: input.startDate,
            endDate: input.endDate,
            configOverrides: {
              params: combo,
              ...(input.feeBps === undefined && input.slippageBps === undefined
                ? {}
                : {
                    execution: {
                      ...(input.feeBps === undefined ? {} : { taker_fee_bps: input.feeBps }),
                      ...(input.slippageBps === undefined ? {} : { slippage_bps: input.slippageBps }),
                    },
                  }),
            },
            source: "sweep",
            robustness: { monteCarloPaths: 0, regimes: true, walkForwardFolds: input.walkForwardFolds },
            sessionID: ctx.sessionID,
            dataSource: { kind: "provider_fetch" },
          })
          if (r.ok) results.push({ params: combo, ok: true, metrics: r.results })
          else results.push({ params: combo, ok: false, error: r.error })
        }

        const successes = results.filter((r) => r.ok && r.metrics)
        if (successes.length === 0) {
          const sample = results[0]?.error ?? "unknown"
          return {
            title: "Sweep failed — every combo errored",
            output: `All ${results.length} combinations failed. Sample error:\n${sample}`,
            metadata: {},
          }
        }

        const best = successes.reduce((a, b) => {
          const aa = nestedOosScore(a.metrics!)
          const bb = nestedOosScore(b.metrics!)
          return (bb.sharpe > aa.sharpe || (bb.sharpe === aa.sharpe && bb.ret > aa.ret) ? b : a)
        })
        const worst = successes.reduce((a, b) => {
          const aa = nestedOosScore(a.metrics!)
          const bb = nestedOosScore(b.metrics!)
          return (bb.sharpe < aa.sharpe || (bb.sharpe === aa.sharpe && bb.ret < aa.ret) ? b : a)
        })

        const sharpes = successes.map((r) => nestedOosScore(r.metrics!).sharpe)
        const returns = successes.map((r) => nestedOosScore(r.metrics!).ret)
        const sharpeRange = Math.max(...sharpes) - Math.min(...sharpes)
        const sharpeAbs = Math.max(...sharpes.map(Math.abs))
        const sharpeFragility = sharpeAbs > 0 ? sharpeRange / sharpeAbs : 0

        let verdict: "robust" | "fragile" | "broken"
        let verdictReason: string
        if (nestedOosScore(best.metrics!).sharpe <= 0) {
          verdict = "broken"
          verdictReason = "Best nested OOS Sharpe across the grid is non-positive — the strategy does not work in this regime."
        } else if (sharpeFragility > 0.5) {
          verdict = "fragile"
          verdictReason = `Sharpe range across the grid is ${(sharpeFragility * 100).toFixed(0)}% of the peak — the strategy's success depends heavily on specific parameter values (likely overfit).`
        } else {
          verdict = "robust"
          verdictReason = "Performance is consistent across the parameter grid — the strategy generalizes across nearby parameter values."
        }

        const tableLines: string[] = []
        const headers = ["params", "nestedOOSReturn%", "nestedOOSSharpe", "nestedOOSTrades", "maxDD%", "winRate%", "PF"]
        tableLines.push(headers.join("\t"))
        for (const r of results) {
          if (!r.ok || !r.metrics) {
            tableLines.push(`${fmtParams(r.params)}\tERROR: ${r.error?.slice(0, 60) ?? ""}`)
            continue
          }
          const m = r.metrics
          const oos = nestedOosScore(m)
          tableLines.push(
            [
              fmtParams(r.params),
              (oos.ret * 100).toFixed(2),
              oos.sharpe.toFixed(2),
              String(oos.trades),
              (m.maxDrawdown * 100).toFixed(2),
              (m.winRate * 100).toFixed(1),
              m.profitFactor == null ? "N/A" : m.profitFactor.toFixed(2),
            ].join("\t"),
          )
        }

        const lines = [
          `Algorithm: ${algo.name} (v${algo.version})`,
          `Grid: ${Object.entries(input.paramGrid).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`,
          `Combinations run: ${results.length} (${successes.length} succeeded)`,
          `Window: ${input.duration} | Interval: ${input.interval} | Capital: $${input.capital}`,
          ``,
          ...tableLines,
          ``,
          `Best:  ${fmtParams(best.params)}  →  nested OOS Sharpe ${nestedOosScore(best.metrics!).sharpe.toFixed(2)}, return ${(nestedOosScore(best.metrics!).ret * 100).toFixed(2)}%`,
          `Worst: ${fmtParams(worst.params)}  →  nested OOS Sharpe ${nestedOosScore(worst.metrics!).sharpe.toFixed(2)}, return ${(nestedOosScore(worst.metrics!).ret * 100).toFixed(2)}%`,
          `Sharpe range: ${sharpeRange.toFixed(2)} (${(sharpeFragility * 100).toFixed(0)}% of peak)`,
          `Return range: ${(Math.max(...returns) * 100 - Math.min(...returns) * 100).toFixed(2)}pp`,
          ``,
          `Verdict: ${verdict.toUpperCase()} — ${verdictReason}`,
        ]

        const riskBanner = Validate.formatRiskBanner(validation)

        const finalOutput = riskBanner ? `${riskBanner}\n\n${lines.join("\n")}` : lines.join("\n")
        return {
          title: `Sweep: ${algo.name} (${verdict}, ${results.length} combos)`,
          output: finalOutput,
          metadata: {},
        }
      }),
  }),
)
