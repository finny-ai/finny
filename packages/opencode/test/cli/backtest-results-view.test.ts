import { describe, expect, test } from "bun:test"
import {
  formatBacktestPlainMetrics,
  formatTableRowLine,
  formatHeaderRowLine,
} from "@tui/component/backtest-results-view"
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
    expect(output).toContain("Crucible 2.0")
    expect(output).toContain("Sharpe 0.86")
    expect(output).toContain("max DD 10.70%")
    expect(output).toContain("trades 4")
    expect(output).toContain("win rate 50.00%")
    expect(output).toContain("profit factor N/A")
  })

  test("includes realized and open-position context when available", () => {
    const output = formatBacktestPlainMetrics({
      totalReturn: 0.0029,
      maxDrawdown: 0.0081,
      annualizedVolatility: 0.05,
      sharpeRatio: 0.58,
      endingEquity: 10028.7,
      totalTrades: 1,
      closedTrades: 1,
      openTradeCount: 1,
      realizedPnl: -16.09,
      unrealizedPnl: 44.85,
      winRate: 0,
      profitFactor: null,
    } as BacktestRunner.Results)

    expect(output).toContain("closed 1")
    expect(output).toContain("open 1")
    expect(output).toContain("realized $-16.09")
    expect(output).toContain("unrealized $44.85")
  })

  test("keeps legacy runs labeled separately", () => {
    const output = formatBacktestPlainMetrics({
      totalReturn: 0.01,
      maxDrawdown: 0.02,
      annualizedVolatility: 0.1,
      sharpeRatio: 0.5,
      endingEquity: 10100,
      totalTrades: 1,
      winRate: 1,
      profitFactor: null,
      runKind: "legacy",
    } as BacktestRunner.Results)

    expect(output).toContain("Legacy backtest")
  })
})

describe("backtest table row rendering", () => {
  test("renders a row as one line containing both label and value", () => {
    const line = formatTableRowLine("Total Return", "-3.73%")
    // The reported bug: rows rendered empty. The single-line form must carry
    // the actual label and value text, not just borders/whitespace.
    expect(line).toContain("Total Return")
    expect(line).toContain("-3.73%")
    expect(line.startsWith("│")).toBe(true)
    expect(line.endsWith("│")).toBe(true)
  })

  test("row and header lines share the same fixed width as the border", () => {
    const border = "┌" + "─".repeat(24) + "┬" + "─".repeat(18) + "┐"
    const row = formatTableRowLine("Sharpe Ratio", "-2.90")
    const header = formatHeaderRowLine("PERFORMANCE")
    expect(row.length).toBe(border.length)
    expect(header.length).toBe(border.length)
  })

  test("value column is right-aligned and label column left-aligned", () => {
    const line = formatTableRowLine("Win Rate", "25.00%")
    const expected = "│ " + "Win Rate".padEnd(22) + " │ " + "25.00%".padStart(16) + " │"
    expect(line).toBe(expected)
    // label flush-left, value flush-right against the separators
    expect(line).toContain("│ Win Rate ")
    expect(line).toContain(" 25.00% │")
  })
})
