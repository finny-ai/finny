import z from "zod"
import path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"

interface BacktestHistoryEntry {
  id: string
  algorithmId: string
  algorithmName: string
  params: { duration: string; interval: string; capital: string }
  results: {
    totalReturn: number
    maxDrawdown: number
    annualizedVolatility: number
    sharpeRatio: number
    endingEquity: number
    totalTrades: number
    winRate: number
    profitFactor: number | null
    productLabel?: string
    runKind?: "crucible_2_0" | "legacy"
    eligibilityStatus?: string
  }
  symbol?: string
  timestamp: number
}

async function readHistory(): Promise<BacktestHistoryEntry[]> {
  try {
    const kvPath = path.join(Global.Path.state, "kv.json")
    const kv = await Filesystem.readJson<Record<string, unknown>>(kvPath)
    const raw = kv?.backtest_history
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function formatBacktestHistoryEntries(entries: BacktestHistoryEntry[]): string {
  const groups = [
    ["Crucible 2.0 runs", entries.filter((e) => e.results.runKind === "crucible_2_0")],
    ["Legacy runs", entries.filter((e) => e.results.runKind !== "crucible_2_0")],
  ] as const

  return groups
    .filter(([, group]) => group.length > 0)
    .map(([title, group]) => {
      const formatted = group.map((e) => {
        const r = e.results
        return [
          `--- ${e.algorithmName} ---`,
          `Run surface: ${r.productLabel ?? (r.runKind === "crucible_2_0" ? "Crucible 2.0" : "Legacy backtest")}`,
          `Date: ${new Date(e.timestamp).toISOString().slice(0, 19)}`,
          `Params: duration=${e.params.duration} interval=${e.params.interval} capital=$${e.params.capital}`,
          e.symbol ? `Symbol: ${e.symbol}` : null,
          r.eligibilityStatus ? `Eligibility: ${r.eligibilityStatus}` : null,
          `Total Return: ${(r.totalReturn * 100).toFixed(2)}%`,
          `Max Drawdown: ${(r.maxDrawdown * 100).toFixed(2)}%`,
          `Sharpe Ratio: ${r.sharpeRatio.toFixed(2)}`,
          `Ending Equity: $${r.endingEquity.toFixed(2)}`,
          `Total Trades: ${r.totalTrades}`,
          `Win Rate: ${(r.winRate * 100).toFixed(1)}%`,
          `Profit Factor: ${r.profitFactor == null ? "N/A" : r.profitFactor.toFixed(2)}`,
          ``,
        ]
          .filter(Boolean)
          .join("\n")
      })
      return [`== ${title} ==`, ...formatted].join("\n")
    })
    .join("\n")
}

const parameters = z.object({
  algorithmName: z
    .string()
    .optional()
    .describe("Filter results to a specific algorithm name. Omit to see all."),
  limit: z
    .number()
    .default(10)
    .describe("Max number of results to return (newest first)"),
})

export const BacktestHistoryTool = Tool.define(
  "finny_backtest_history",
  Effect.succeed({
    description:
      "Read past backtest results from history. Returns recent backtests with their parameters and performance metrics. " +
      "Use this when the user asks about past backtest performance, wants to compare results across intervals/durations, " +
      "or asks questions like 'why is my 5min backtest so low?'. Optionally filter by algorithm name.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_backtest_history",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        let entries = await readHistory()
        entries.sort((a, b) => b.timestamp - a.timestamp)

        if (params.algorithmName) {
          const name = params.algorithmName.toLowerCase()
          entries = entries.filter((e) => e.algorithmName.toLowerCase() === name)
        }

        entries = entries.slice(0, params.limit)

        if (entries.length === 0) {
          const msg = params.algorithmName
            ? `No backtest history found for "${params.algorithmName}". Run a backtest first with finny_backtest_run.`
            : "No backtest history found. Run a backtest first with finny_backtest_run."
          return {
            title: "No backtest history",
            output: msg,
            metadata: { count: 0 },
          }
        }

        return {
          title: `${entries.length} backtest result${entries.length === 1 ? "" : "s"}`,
          output: formatBacktestHistoryEntries(entries),
          metadata: { count: entries.length },
        }
      }),
  }),
)
