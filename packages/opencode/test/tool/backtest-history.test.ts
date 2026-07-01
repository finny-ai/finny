import { describe, expect, test } from "bun:test"
import { mergeBacktestHistoryEntries } from "../../src/backtest/store"
import type { Manifest, ResultSummary } from "../../src/backtest/store"
import { formatBacktestHistoryEntries } from "../../src/tool/backtest-history"

const base: Omit<Manifest, "results"> = {
  id: "run-1",
  source: "run" as const,
  algorithmId: "a",
  algorithmName: "algo",
  algorithmVersion: 1,
  params: { duration: "1m", interval: "1d", capital: "10000" },
  assumptions: { feeBps: 7.5, slippageBps: 1, fillModel: "next_open" },
  symbol: "BTC/USD",
  benchmark: { kind: "buy_and_hold" as const, totalReturn: 0.04, maxDrawdown: 0.02, endingEquity: 10400 },
  alpha: 0.06,
  artifacts: { equityCurve: "equity.csv", trades: "trades.csv", sourceArtifacts: "/tmp/source" },
  dir: "/tmp/evidence",
  timestamp: Date.UTC(2026, 0, 1),
}

function results(over: Partial<ResultSummary>): ResultSummary {
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
      { ...base, results: results({ productLabel: "Crucible 2.0", runKind: "crucible_2_0", eligibilityStatus: "paper_eligible" }) },
      { ...base, algorithmName: "legacy", results: results({ productLabel: "Legacy backtest", runKind: "legacy" }) },
    ])

    expect(output).toContain("== Crucible 2.0 runs ==")
    expect(output).toContain("Run surface: Crucible 2.0")
    expect(output).toContain("Eligibility: paper_eligible")
    expect(output).toContain("Benchmark Return: 4.00% | Alpha: 6.00 pts")
    expect(output).toContain("Evidence: /tmp/evidence")
    expect(output).toContain("== Legacy runs ==")
    expect(output).toContain("Run surface: Legacy backtest")
  })

  test("treats pre-migration entries without runKind as legacy", () => {
    const output = formatBacktestHistoryEntries([
      { ...base, results: results({}) },
    ])

    expect(output).toContain("== Legacy runs ==")
    expect(output).not.toContain("== Crucible 2.0 runs ==")
    expect(output).toContain("Run surface: Legacy backtest")
  })

  test("merges legacy kv history with durable history and prefers durable duplicates", () => {
    const durable: Manifest = { ...base, id: "shared", timestamp: 2000, results: results({ productLabel: "Crucible 2.0", runKind: "crucible_2_0" }) }
    const legacy: Manifest[] = [
      { ...base, id: "legacy-only", algorithmName: "legacy", timestamp: 3000, results: results({}) },
      { ...base, id: "shared", timestamp: 1000, results: results({ productLabel: "Legacy backtest", runKind: "legacy" }) },
    ]

    const entries = mergeBacktestHistoryEntries({ durable: [durable], legacy, limit: 10 })
    expect(entries.map((entry) => entry.id)).toEqual(["legacy-only", "shared"])
    expect(entries.find((entry) => entry.id === "shared")?.results.runKind).toBe("crucible_2_0")

    const filtered = mergeBacktestHistoryEntries({ durable: [durable], legacy, algorithmName: "legacy", limit: 10 })
    expect(filtered.map((entry) => entry.id)).toEqual(["legacy-only"])

    const filteredById = mergeBacktestHistoryEntries({ durable: [durable], legacy, algorithmId: "a", limit: 10 })
    expect(filteredById.map((entry) => entry.id)).toEqual(["legacy-only", "shared"])
  })
})
