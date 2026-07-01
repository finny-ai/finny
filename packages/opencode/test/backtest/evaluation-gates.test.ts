import { describe, expect, test } from "bun:test"
import { evaluateBacktestQuality } from "../../src/backtest/evaluation"
import type { BacktestRunner } from "../../src/backtest/runner"

function result(overrides: Partial<BacktestRunner.Results>): BacktestRunner.Results {
  return {
    totalReturn: 0.1,
    maxDrawdown: 0.05,
    annualizedVolatility: 0.12,
    sharpeRatio: 1.2,
    endingEquity: 11000,
    totalTrades: 40,
    winRate: 0.55,
    profitFactor: 1.8,
    benchmarkReturn: 0.04,
    benchmarkSharpeRatio: 0.8,
    benchmarkMaxDrawdown: 0.08,
    alpha: 0.06,
    diagnostics: {
      barsProcessed: 1000,
      buyAttempts: 40,
      sellAttempts: 40,
      rejectedOrders: 0,
      rejectionReasons: {},
      priceFirst: 100,
      priceLast: 110,
      priceRangePct: 0.1,
      strategyErrors: 0,
    },
    ...overrides,
  }
}

describe("evaluateBacktestQuality", () => {
  test("classifies a 1-trade positive result as inconclusive", () => {
    const quality = evaluateBacktestQuality(result({ totalTrades: 1 }))
    expect(quality.label).toBe("inconclusive")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons.join("; ")).toContain("closed trade count below minimum")
  })

  test("classifies open-PnL-only positive MTM results as inconclusive", () => {
    const quality = evaluateBacktestQuality(result({
      totalReturn: 0.003,
      totalTrades: 12,
      realizedPnl: -16,
      unrealizedPnl: 45,
    }))
    expect(quality.label).toBe("inconclusive")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons.join("; ")).toContain("open unrealized PnL")
  })

  test("rejects a sufficiently sampled QQQ-style positive result as weak positive", () => {
    const quality = evaluateBacktestQuality(result({
      totalReturn: 0.0789,
      sharpeRatio: 0.86,
      maxDrawdown: 0.107,
      totalTrades: 12,
      profitFactor: 1.4,
    }))
    expect(quality.label).toBe("weak_positive")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons.join("; ")).toContain("Sharpe < 1.0")
  })

  test("fails positive-return runs that lag buy-and-hold", () => {
    const quality = evaluateBacktestQuality(result({
      totalReturn: 0.04,
      benchmarkReturn: 0.08,
      alpha: -0.04,
    }))
    expect(quality.label).toBe("failed")
    expect(quality.reasons).toContain("alpha vs buy-and-hold <= 0")
  })

  test("blocks strict results when the buy-and-hold benchmark is unavailable", () => {
    const quality = evaluateBacktestQuality(result({
      runKind: "crucible_2_0",
      productLabel: "Crucible 2.0",
      benchmarkReturn: undefined,
      benchmarkMaxDrawdown: undefined,
      benchmarkSharpeRatio: undefined,
      alpha: undefined,
    }))
    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("buy-and-hold benchmark unavailable")
  })

  test("keeps defensive outperformance blocked by the absolute return gate", () => {
    const quality = evaluateBacktestQuality(result({
      totalReturn: -0.04,
      benchmarkReturn: -0.12,
      alpha: 0.08,
    }))
    expect(quality.label).toBe("failed")
    expect(quality.reasons).toContain("liquidation-adjusted return <= 0")
    expect(quality.reasons).not.toContain("alpha vs buy-and-hold <= 0")
  })

  test("allows robust results to become paper eligible", () => {
    const quality = evaluateBacktestQuality(result({
      benchmarkReturn: 0.02,
      benchmarkMaxDrawdown: 0.08,
      benchmarkSharpeRatio: 0.8,
      alpha: 0.08,
      v2: {
        walk_forward: {
          n_folds: 5,
          is_sharpe_mean: 1.4,
          oos_sharpe_mean: 1.1,
          oos_decay: 0.78,
          is_to_oos_sharpe_change: -0.3,
          flag_threshold: 0.7,
          flagged: false,
          deflated_sharpe: 0.8,
          probabilistic_sharpe: 0.9,
          stitched_oos_return: 0.08,
          stitched_oos_sharpe: 1.1,
          stitched_oos_trades: 30,
          stitched_oos_bars: 300,
          stitched_oos_coverage: 1,
          ruined_folds: 0,
          multiple_testing_trials: 1,
          folds: [],
        },
      } as any,
    }))
    expect(quality.label).toBe("paper_eligible")
    expect(quality.paperEligible).toBe(true)
  })

  test("requires positive stitched OOS return and enough OOS trades", () => {
    const quality = evaluateBacktestQuality(result({
      benchmarkReturn: 0.02,
      benchmarkMaxDrawdown: 0.08,
      benchmarkSharpeRatio: 0.8,
      alpha: 0.08,
      v2: {
        walk_forward: {
          n_folds: 5,
          is_sharpe_mean: 1.4,
          oos_sharpe_mean: 1.1,
          oos_decay: 0.78,
          is_to_oos_sharpe_change: -0.3,
          flag_threshold: 0.7,
          flagged: false,
          deflated_sharpe: 0.8,
          probabilistic_sharpe: 0.9,
          stitched_oos_return: -0.01,
          stitched_oos_sharpe: 1.1,
          stitched_oos_trades: 2,
          stitched_oos_bars: 300,
          stitched_oos_coverage: 1,
          ruined_folds: 0,
          folds: [],
        },
      } as any,
    }))
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("stitched OOS return <= 0")
    expect(quality.reasons.join("; ")).toContain("stitched OOS trade count low")
  })

  test("repaired-data result cannot be paper eligible", () => {
    const quality = evaluateBacktestQuality(result({
      v2: {
        data_quality: {
          n_bars: 1000,
          coverage_pct: 1,
          gap_count: 0,
          duplicate_ts_count: 0,
          ohlc_violations: 0,
          outlier_bars: 0,
          zero_volume_bars: 0,
          notes: [],
          repaired_outliers: 1,
          repair_applied: true,
        },
      } as any,
    }))
    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("uses repaired data")
  })

  test("uses liquidation-adjusted NAV for eligibility", () => {
    const quality = evaluateBacktestQuality(result({
      totalReturn: 0.1,
      maxDrawdown: 0.05,
      v2: {
        starting_equity: 10000,
        run_metadata: {
          liquidation_nav: { nav: 9900, canceled_pending_orders: 1, hypothetical_closes: [] },
        },
      } as any,
    }))
    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("liquidation-adjusted return <= 0")
  })
})
