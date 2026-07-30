import { describe, expect, test } from "bun:test"
import { evaluateBacktestQuality } from "../../src/backtest/evaluation"
import type { BacktestRunner } from "../../src/backtest/runner"
import {
  makeHoldoutOpenEventV1,
  makeQualificationPolicyV1,
  type QualificationContextV1,
  type QualificationPolicyV1,
} from "../../src/backtest/qualification-policy"

const CONTEXT: QualificationContextV1 = {
  schema: "finny.qualification_context",
  version: 1,
  planId: "plan-test",
  planHash: "a".repeat(64),
  phase: "confirmatory",
  holdoutOpenEvents: [
    makeHoldoutOpenEventV1({
      planId: "plan-test",
      planHash: "a".repeat(64),
      approvalHash: "c".repeat(64),
      openedAt: "2026-07-14T00:00:00.000Z",
    }),
  ],
  durableSelectionBudget: 20,
  durableTrialCount: 1,
  datasetEvidenceId: "dataset-test",
  datasetHash: "b".repeat(64),
  datasetQualification: "strict_qualified",
  dataQualityMode: "strict",
}

function evaluate(
  results: BacktestRunner.Results,
  overrides: Partial<QualificationPolicyV1> & { phase?: QualificationContextV1["phase"] } = {},
) {
  const { phase = "confirmatory", ...policy } = overrides
  return evaluateBacktestQuality(results, {
    policy: makeQualificationPolicyV1({
      minDeflatedSharpe: 0,
      minProbabilisticSharpe: 0,
      minWalkForwardFolds: 0,
      requireCostSensitivity: false,
      requireBenchmark: false,
      requireRiskContract: false,
      ...policy,
    }),
    context: { ...CONTEXT, phase },
  })
}

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
    const quality = evaluate(result({ totalTrades: 1 }))
    expect(quality.label).toBe("inconclusive")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons.join("; ")).toContain("closed trade count below minimum")
  })

  test("classifies open-PnL-only positive MTM results as inconclusive", () => {
    const quality = evaluate(
      result({
        totalReturn: 0.003,
        totalTrades: 12,
        realizedPnl: -16,
        unrealizedPnl: 45,
      }),
    )
    expect(quality.label).toBe("inconclusive")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons.join("; ")).toContain("open unrealized PnL")
  })

  test("rejects a QQQ-style positive result below the mandatory sample floor as inconclusive", () => {
    const quality = evaluate(
      result({
        totalReturn: 0.0789,
        sharpeRatio: 0.86,
        maxDrawdown: 0.107,
        totalTrades: 12,
        profitFactor: 1.4,
      }),
    )
    expect(quality.label).toBe("inconclusive")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons.join("; ")).toContain("closed trade count below minimum")
  })

  test("fails positive-return runs that lag buy-and-hold", () => {
    const quality = evaluate(
      result({
        totalReturn: 0.04,
        benchmarkReturn: 0.08,
        alpha: -0.04,
      }),
    )
    expect(quality.label).toBe("failed")
    expect(quality.reasons).toContain("alpha vs buy-and-hold <= 0")
  })

  test("blocks strict results when the buy-and-hold benchmark is unavailable", () => {
    const quality = evaluate(
      result({
        runKind: "crucible_2_0",
        productLabel: "Crucible 2.0",
        benchmarkReturn: undefined,
        benchmarkMaxDrawdown: undefined,
        benchmarkSharpeRatio: undefined,
        alpha: undefined,
      }),
    )
    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("buy-and-hold benchmark unavailable")
  })

  test("does not require benchmark for legacy stability blobs", () => {
    const quality = evaluate(
      result({
        runKind: "legacy",
        productLabel: "Legacy backtest",
        benchmarkReturn: undefined,
        benchmarkMaxDrawdown: undefined,
        benchmarkSharpeRatio: undefined,
        alpha: undefined,
        v2: {
          stability: { equity_curve_r2: 0.9 },
        } as any,
      }),
    )

    expect(quality.reasons).not.toContain("buy-and-hold benchmark unavailable")
  })

  test("does not compare legacy strategy Sharpe against calendar-adjusted benchmark Sharpe", () => {
    const quality = evaluate(
      result({
        runKind: "legacy",
        productLabel: "Legacy backtest",
        sharpeRatio: 1.2,
        benchmarkSharpeRatio: 2.4,
      }),
    )

    expect(quality.reasons).not.toContain("Sharpe <= buy-and-hold Sharpe")
  })

  test("labels runs without optional walk-forward as unevaluated, not candidate", () => {
    const quality = evaluate(
      result({
        runKind: "legacy",
        productLabel: "Legacy backtest",
      }),
    )

    expect(quality.label).toBe("unevaluated")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("walk-forward robustness not run")
    expect(quality.reasons).toContain("legacy/v3 risk contract is research-only")
  })

  test("fails explicitly when policy-required walk-forward is missing", () => {
    const quality = evaluate(result({}), { minWalkForwardFolds: 5 })

    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("walk-forward robustness required by policy (5 folds) but not run")
    expect(quality.reasons).not.toContain("walk-forward robustness not run")
  })

  test("keeps optional missing walk-forward unevaluated even when absolute gates are weak", () => {
    const quality = evaluate(result({ sharpeRatio: 0.8, profitFactor: 1.2 }))

    expect(quality.label).toBe("unevaluated")
    expect(quality.reasons).toContain("Sharpe < 1.0")
    expect(quality.reasons).toContain("profit factor < 1.5")
    expect(quality.reasons).toContain("walk-forward robustness not run")
  })

  test("keeps defensive outperformance blocked by the absolute return gate", () => {
    const quality = evaluate(
      result({
        totalReturn: -0.04,
        benchmarkReturn: -0.12,
        alpha: 0.08,
      }),
    )
    expect(quality.label).toBe("failed")
    expect(quality.reasons).toContain("liquidation-adjusted return <= 0")
    expect(quality.reasons).not.toContain("alpha vs buy-and-hold <= 0")
  })

  test("allows robust results to become paper eligible", () => {
    const quality = evaluate(
      result({
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
      }),
    )
    expect(quality.label).toBe("paper_eligible")
    expect(quality.paperEligible).toBe(true)
  })

  test("applies configured DSR, PSR, sample, and confirmatory phase gates", () => {
    const robust = result({
      totalTrades: 40,
      v2: {
        walk_forward: {
          n_folds: 5,
          is_sharpe_mean: 1.4,
          oos_sharpe_mean: 1.1,
          oos_decay: 0.78,
          flag_threshold: 0.7,
          flagged: false,
          deflated_sharpe: 0.8,
          probabilistic_sharpe: 0.9,
          stitched_oos_return: 0.08,
          stitched_oos_sharpe: 1.1,
          stitched_oos_trades: 40,
          stitched_oos_coverage: 1,
          ruined_folds: 0,
          folds: [],
        },
      } as any,
    })
    const quality = evaluate(robust, {
      minDeflatedSharpe: 0.95,
      minProbabilisticSharpe: 0.95,
      minOosCoverage: 0.95,
      minTrades: 30,
      requireCostSensitivity: false,
      phase: "validation",
    })
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("deflated Sharpe probability < 0.95")
    expect(quality.reasons).toContain("probabilistic Sharpe probability < 0.95")
    expect(quality.reasons).toContain("experiment phase is validation, not confirmatory")

    const confirmatory = evaluate(
      {
        ...result({}),
        totalTrades: 40,
        sensitivityOutcomes: [{ name: "Cost/slippage stress", status: "pass", value: 0.02, explanation: "" }],
        v2: {
          walk_forward: {
            ...(robust.v2 as any).walk_forward,
            deflated_sharpe: 0.99,
            probabilistic_sharpe: 0.99,
          },
        } as any,
      },
      {
        minDeflatedSharpe: 0.95,
        minProbabilisticSharpe: 0.95,
        minOosCoverage: 0.95,
        minTrades: 30,
        requireCostSensitivity: true,
        phase: "confirmatory",
      },
    )
    expect(confirmatory.label).toBe("paper_eligible")
  })

  test("requires positive stitched OOS return and enough OOS trades", () => {
    const quality = evaluate(
      result({
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
      }),
    )
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("stitched OOS return <= 0")
    expect(quality.reasons.join("; ")).toContain("stitched OOS trade count low")
  })

  test("rejects legacy negative-over-negative walk-forward artifacts", () => {
    const quality = evaluate(
      result({
        benchmarkReturn: 0.02,
        benchmarkMaxDrawdown: 0.08,
        benchmarkSharpeRatio: 0.8,
        alpha: 0.08,
        v2: {
          walk_forward: {
            n_folds: 5,
            is_sharpe_mean: -0.5,
            oos_sharpe_mean: -0.2,
            oos_decay: 0.4,
            is_to_oos_sharpe_change: 0.3,
            flag_threshold: 0.5,
            flagged: false,
            deflated_sharpe: 0.1,
            probabilistic_sharpe: 0.1,
            stitched_oos_return: 0.02,
            stitched_oos_sharpe: 0.2,
            stitched_oos_trades: 30,
            stitched_oos_bars: 300,
            stitched_oos_coverage: 1,
            ruined_folds: 0,
            folds: [],
          },
        } as any,
      }),
    )

    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("walk-forward IS Sharpe <= 0")
  })

  test("repaired-data result cannot be paper eligible", () => {
    const quality = evaluate(
      result({
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
      }),
    )
    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("uses repaired data")
  })

  test("repair_outliers mode is research-only even when no repair was applied", () => {
    const quality = evaluate(
      result({
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
            repaired_outliers: 0,
            repair_applied: false,
          },
        } as any,
      }),
      {},
    )
    const repairedMode = evaluateBacktestQuality(result({}), {
      policy: makeQualificationPolicyV1({ requireCostSensitivity: false, requireRiskContract: false }),
      context: { ...CONTEXT, dataQualityMode: "repair_outliers" },
    })
    expect(quality.paperEligible).toBe(false)
    expect(repairedMode.label).toBe("failed")
    expect(repairedMode.reasons).toContain("data quality mode repair_outliers is research-only")
  })

  test("a triggered drawdown contract cannot become paper eligible", () => {
    const quality = evaluate(
      result({
        v2: {
          diagnostics: {
            drawdown_trigger: {
              bar_index: 100,
              drawdown_pct: 10.1,
              limit_pct: 10,
              flatten_status: "completed",
            },
          },
        } as any,
      }),
    )
    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("drawdown risk contract triggered")
  })

  test("uses liquidation-adjusted NAV for eligibility", () => {
    const quality = evaluate(
      result({
        totalReturn: 0.1,
        maxDrawdown: 0.05,
        v2: {
          starting_equity: 10000,
          run_metadata: {
            liquidation_nav: { nav: 9900, canceled_pending_orders: 1, hypothetical_closes: [] },
          },
        } as any,
      }),
    )
    expect(quality.label).toBe("failed")
    expect(quality.paperEligible).toBe(false)
    expect(quality.reasons).toContain("liquidation-adjusted return <= 0")
  })
})
