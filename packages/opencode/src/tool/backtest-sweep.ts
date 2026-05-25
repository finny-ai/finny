import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"
import { Validate } from "../algorithm/validate"

const MAX_COMBOS = 27

const parameters = z.object({
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
    .default("1m")
    .describe("Backtest period for each combo. Same format as finny_backtest_run."),
  interval: z
    .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
    .default("5min")
    .describe("Bar interval"),
  capital: z.string().default("10000").describe("Starting capital in USD"),
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

export const BacktestSweepTool = Tool.define(
  "finny_backtest_sweep",
  Effect.succeed({
    description:
      "Run a parameter sweep: backtests every combination from the supplied param grid and reports " +
      "a performance matrix plus sensitivity analysis. Use this to detect parameter overfitting — " +
      "a robust strategy performs similarly across nearby parameter values; a fragile strategy has " +
      "wildly different metrics for small changes. Cap of " + MAX_COMBOS + " total combinations. " +
      "The strategy MUST accept a `params` kwarg in its constructor and read values from it; " +
      "otherwise every combo runs identical code and the sweep is meaningless.",
    parameters,
    execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) =>
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
            configOverrides: { params: combo },
            robustness: { monteCarloPaths: 0, regimes: true, walkForwardFolds: 5 },
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

        const best = successes.reduce((a, b) =>
          (b.metrics!.sharpeRatio > a.metrics!.sharpeRatio ? b : a),
        )
        const worst = successes.reduce((a, b) =>
          (b.metrics!.sharpeRatio < a.metrics!.sharpeRatio ? b : a),
        )

        const sharpes = successes.map((r) => r.metrics!.sharpeRatio)
        const returns = successes.map((r) => r.metrics!.totalReturn)
        const sharpeRange = Math.max(...sharpes) - Math.min(...sharpes)
        const sharpeAbs = Math.max(...sharpes.map(Math.abs))
        const sharpeFragility = sharpeAbs > 0 ? sharpeRange / sharpeAbs : 0

        let verdict: "robust" | "fragile" | "broken"
        let verdictReason: string
        if (best.metrics!.sharpeRatio <= 0) {
          verdict = "broken"
          verdictReason = "Best Sharpe across the grid is non-positive — the strategy does not work in this regime."
        } else if (sharpeFragility > 0.5) {
          verdict = "fragile"
          verdictReason = `Sharpe range across the grid is ${(sharpeFragility * 100).toFixed(0)}% of the peak — the strategy's success depends heavily on specific parameter values (likely overfit).`
        } else {
          verdict = "robust"
          verdictReason = "Performance is consistent across the parameter grid — the strategy generalizes across nearby parameter values."
        }

        const tableLines: string[] = []
        const headers = ["params", "return%", "sharpe", "maxDD%", "trades", "winRate%", "PF"]
        tableLines.push(headers.join("\t"))
        for (const r of results) {
          if (!r.ok || !r.metrics) {
            tableLines.push(`${fmtParams(r.params)}\tERROR: ${r.error?.slice(0, 60) ?? ""}`)
            continue
          }
          const m = r.metrics
          tableLines.push(
            [
              fmtParams(r.params),
              (m.totalReturn * 100).toFixed(2),
              m.sharpeRatio.toFixed(2),
              (m.maxDrawdown * 100).toFixed(2),
              String(m.totalTrades),
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
          `Best:  ${fmtParams(best.params)}  →  Sharpe ${best.metrics!.sharpeRatio.toFixed(2)}, return ${(best.metrics!.totalReturn * 100).toFixed(2)}%`,
          `Worst: ${fmtParams(worst.params)}  →  Sharpe ${worst.metrics!.sharpeRatio.toFixed(2)}, return ${(worst.metrics!.totalReturn * 100).toFixed(2)}%`,
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
