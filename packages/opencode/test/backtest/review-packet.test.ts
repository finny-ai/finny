import { describe, expect, test } from "bun:test"
import { buildDurabilityReport, renderReviewHtml, renderReviewMarkdown } from "../../src/backtest/review-packet"

const algorithm = {
  algorithmId: "algo_1",
  name: "spy-test",
  version: 2,
} as any

const results = {
  runId: "run_1",
  totalReturn: 0.12,
  maxDrawdown: 0.08,
  sharpeRatio: 1.2,
  totalTrades: 24,
  v2: {
    start_ts: "2026-01-01T00:00:00Z",
    end_ts: "2026-07-01T00:00:00Z",
    interval: "1h",
    bars_processed: 1000,
    stability: {
      rolling_sharpe_window: 90,
      rolling_sharpe_mean: 1.1,
      rolling_sharpe_min: -0.2,
      monthly_returns: { "2026": { "01": 0.01, "02": -0.02 } },
    },
    walk_forward: { folds: [{ oos_sharpe: 0.8 }, { oos_sharpe: -0.1 }] },
    trade: { expectancy: 12 },
    consistency: { label: "consistent", confidence: "high" },
    alpha_decay: {
      label: "stable",
      confidence: "high",
      mann_kendall: { trend: "no_trend" },
      breakeven: { status: "no_measured_decay", months: null, per_trade_cost: 1, n_months: 6, n_trades: 24 },
    },
  },
} as any

describe("review packet rendering", () => {
  test("renders markdown, five svg charts, and durability schema", () => {
    const input = {
      algorithm,
      results,
      verdict: "recommended_for_paper" as const,
      reasons: ["durable"],
      equity: [100, 102, 101, 110],
      benchmark: [100, 101, 103, 105],
      drawdown: [0, 0, -0.01, 0],
      rollingSharpe: [0.5, 0.8, 1.1],
    }
    expect(renderReviewMarkdown(input)).toContain("# Backtest Review: spy-test")
    const html = renderReviewHtml(input)
    expect((html.match(/<svg/g) ?? []).length).toBe(5)
    const durability = buildDurabilityReport(input)
    expect(durability.schema).toBe("finny.durability")
    expect(durability.verdict).toBe("recommended_for_paper")
  })
})
