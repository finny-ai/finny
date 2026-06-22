import { describe, expect, test } from "bun:test"
import { formatBacktestHistoryEntries } from "../../src/tool/backtest-history"

const base = {
  id: "run-1",
  algorithmId: "a",
  algorithmName: "algo",
  params: { duration: "1m", interval: "1d", capital: "10000" },
  symbol: "BTC/USD",
  timestamp: Date.UTC(2026, 0, 1),
}

function results(over: Record<string, unknown>) {
  return {
    totalReturn: 0.1,
    maxDrawdown: 0.05,
    annualizedVolatility: 0.2,
    sharpeRatio: 1.1,
    endingEquity: 11000,
    totalTrades: 4,
    winRate: 0.5,
    profitFactor: null,
    ...over,
  }
}

describe("formatBacktestHistoryEntries", () => {
  test("separates Crucible 2.0 and legacy runs", () => {
    const output = formatBacktestHistoryEntries([
      { ...base, results: results({ productLabel: "Crucible 2.0", runKind: "crucible_2_0", eligibilityStatus: "paper_eligible" }) as any },
      { ...base, algorithmName: "legacy", results: results({ productLabel: "Legacy backtest", runKind: "legacy" }) as any },
    ])

    expect(output).toContain("== Crucible 2.0 runs ==")
    expect(output).toContain("Run surface: Crucible 2.0")
    expect(output).toContain("Eligibility: paper_eligible")
    expect(output).toContain("== Legacy runs ==")
    expect(output).toContain("Run surface: Legacy backtest")
  })

  test("treats pre-migration entries without runKind as legacy", () => {
    const output = formatBacktestHistoryEntries([
      { ...base, results: results({}) as any },
    ])

    expect(output).toContain("== Legacy runs ==")
    expect(output).not.toContain("== Crucible 2.0 runs ==")
    expect(output).toContain("Run surface: Legacy backtest")
  })
})
