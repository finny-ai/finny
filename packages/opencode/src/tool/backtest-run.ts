import z from "zod"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"

export const BacktestRunTool = Tool.define("finny_backtest_run", {
  description:
    "Run a backtest on a saved algorithm. Returns performance metrics including total return, max drawdown, Sharpe ratio, win rate, profit factor, and more. Use this to evaluate strategy performance before suggesting changes or going live.",
  parameters: z.object({
    algorithmName: z
      .string()
      .describe("Name of the saved algorithm to backtest (e.g. 'uco-intraday-hybrid')"),
    duration: z
      .enum(["1w", "1m", "3m", "6m", "1y"])
      .default("1m")
      .describe("Backtest period: 1w=1 week, 1m=1 month, 3m=3 months, 6m=6 months, 1y=1 year"),
    interval: z
      .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
      .default("5min")
      .describe("Bar interval. Should match the algorithm's designed interval."),
    capital: z
      .string()
      .default("10000")
      .describe("Starting capital in USD (e.g. '10000')"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "finny_backtest_run",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const algo = await Algorithm.get(params.algorithmName)
    if (!algo) {
      return {
        title: "Backtest failed",
        output: `Algorithm "${params.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
        metadata: {},
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
        metadata: {},
      }
    }

    const r = result.results
    const lines = [
      `Algorithm: ${algo.name} (v${algo.version})`,
      `Duration: ${params.duration} | Interval: ${params.interval} | Capital: $${params.capital}`,
      ``,
      `Total Return: ${(r.totalReturn * 100).toFixed(2)}%`,
      `Max Drawdown: ${(r.maxDrawdown * 100).toFixed(2)}%`,
      `Annualized Volatility: ${(r.annualizedVolatility * 100).toFixed(2)}%`,
      `Sharpe Ratio: ${r.sharpeRatio.toFixed(2)}`,
      `Ending Equity: $${r.endingEquity.toFixed(2)}`,
      `Total Trades: ${r.totalTrades}`,
      `Win Rate: ${(r.winRate * 100).toFixed(1)}%`,
      `Profit Factor: ${r.profitFactor.toFixed(2)}`,
    ]

    return {
      title: `Backtest: ${algo.name} (${params.duration}, ${params.interval})`,
      output: lines.join("\n"),
      metadata: {},
    }
  },
})
