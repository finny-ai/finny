import { describe, expect, test } from "bun:test"
import { formatBacktestPlainMetrics } from "../../src/cli/cmd/tui/component/backtest-results-view"
import type { BacktestRunner } from "../../src/backtest/runner"

describe("backtest result plain metrics", () => {
  test("formats transcript/export-visible metrics", () => {
    const output = formatBacktestPlainMetrics({
      totalReturn: 0.0789,
      maxDrawdown: 0.107,
      annualizedVolatility: 0.2,
      sharpeRatio: 0.86,
      endingEquity: 10789,
      totalTrades: 4,
      winRate: 0.5,
      profitFactor: null,
    } as BacktestRunner.Results)

    expect(output).toContain("return +7.89%")
    expect(output).toContain("Sharpe 0.86")
    expect(output).toContain("max DD 10.70%")
    expect(output).toContain("trades 4")
    expect(output).toContain("win rate 50.00%")
    expect(output).toContain("profit factor N/A")
  })
})
