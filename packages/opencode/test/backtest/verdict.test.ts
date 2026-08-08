import { describe, expect, test } from "bun:test"
import { composeBacktestVerdict, deriveWalkForwardVerdict, enforceRobustWorkflowVerdict, isRobustQualifiedResult } from "../../src/backtest/verdict"
import type { BacktestQuality } from "../../src/backtest/evaluation"
import type { EngineV2 } from "../../src/backtest/results"

const weakQuality: BacktestQuality = {
  label: "weak_positive",
  paperEligible: false,
  reasons: ["Sharpe < 1.0"],
  deltas: [],
  minTrades: 3,
}

const candidateQuality: BacktestQuality = {
  label: "candidate",
  paperEligible: false,
  reasons: [],
  deltas: [],
  minTrades: 3,
}

const robustWf = { verdict: "robust" as const, reason: "robust" }
const walkForward = (overrides: Partial<EngineV2.WalkForwardSummary> = {}): EngineV2.WalkForwardSummary => ({
  n_folds: 5,
  is_sharpe_mean: 1.2,
  oos_sharpe_mean: 0.9,
  oos_decay: 0.75,
  is_to_oos_sharpe_change: -0.3,
  flag_threshold: 0.5,
  flagged: false,
  deflated_sharpe: 0.8,
  probabilistic_sharpe: 0.9,
  stitched_oos_return: 0.05,
  stitched_oos_sharpe: 0.9,
  stitched_oos_trades: 20,
  stitched_oos_bars: 100,
  stitched_oos_coverage: 1,
  ruined_folds: 0,
  multiple_testing_trials: 1,
  folds: [],
  ...overrides,
})
const consistent = {
  label: "consistent" as const,
  confidence: "high" as const,
  equity_curve_r2: 0.9,
  k_ratio: 1,
  fold_icir: 1,
  rolling_sharpe_mean: 1,
  rolling_sharpe_min: 0,
  rolling_sharpe_max: 2,
  period_rule: "1ME",
  pct_positive_periods: 0.7,
  max_consecutive_losing_periods: 1,
  top_period_return_share: 0.2,
  n_periods: 12,
}
const stable = {
  label: "stable" as const,
  confidence: "high" as const,
  mann_kendall: { trend: "no_trend" as const, s: 0, z: 0, p_value: 1, n: 120 },
  fold_slope: { slope: 0, r_squared: 0, n: 5 },
  breakeven: { status: "no_measured_decay" as const, months: null, slope: 0, latest_gross_expectancy: 10, per_trade_cost: 1, n_months: 6, n_trades: 30 },
}

describe("composeBacktestVerdict", () => {
  test("modest positive durable result uplifts to candidate, not failed", () => {
    expect(composeBacktestVerdict({
      quality: weakQuality,
      walkForward: robustWf,
      consistency: consistent,
      decay: stable,
    }).verdict).toBe("candidate")
  })

  test("candidate durable result requires approval at recommended top rung", () => {
    expect(composeBacktestVerdict({
      quality: candidateQuality,
      walkForward: robustWf,
      consistency: consistent,
      decay: stable,
    }).verdict).toBe("recommended_for_paper")
  })

  test("insufficient durability caps but does not fail", () => {
    expect(composeBacktestVerdict({
      quality: candidateQuality,
      walkForward: robustWf,
      consistency: { ...consistent, label: "insufficient", reasons: ["short history"] },
      decay: { ...stable, label: "insufficient", confidence: "insufficient" },
    }).verdict).toBe("candidate")
  })

  test("walk-forward failed short-circuits", () => {
    expect(deriveWalkForwardVerdict({ n_folds: 0 } as any).verdict).toBe("failed")
    expect(composeBacktestVerdict({
      quality: candidateQuality,
      walkForward: { verdict: "failed", reason: "wf failed" },
      consistency: consistent,
      decay: stable,
    }).verdict).toBe("failed")
  })

  test("rejects legacy negative-over-negative decay artifacts", () => {
    const result = deriveWalkForwardVerdict(walkForward({
      is_sharpe_mean: -0.5,
      oos_sharpe_mean: -0.2,
      oos_decay: 0.4,
      flagged: false,
      flag_reasons: undefined,
    }))

    expect(result.verdict).toBe("failed")
  })

  test("rejects nullable decay and structured failure reasons", () => {
    const result = deriveWalkForwardVerdict(walkForward({
      is_sharpe_mean: 0,
      oos_decay: null,
      flagged: true,
      flag_reasons: ["nonpositive_is_sharpe"],
    }))

    expect(result.verdict).toBe("failed")
    expect(result.reason).toContain("nonpositive_is_sharpe")
  })

  test("rejects nonpositive stitched metrics even when the derived flag is false", () => {
    expect(deriveWalkForwardVerdict(walkForward({
      flagged: false,
      stitched_oos_return: -0.01,
    })).verdict).toBe("failed")
    expect(deriveWalkForwardVerdict(walkForward({
      flagged: false,
      stitched_oos_sharpe: -0.1,
    })).verdict).toBe("failed")
  })

  test("keeps the legacy degraded retention band distinct from failure", () => {
    expect(deriveWalkForwardVerdict(walkForward({ oos_decay: 0.6 })).verdict).toBe("degraded")
    expect(deriveWalkForwardVerdict(walkForward({ oos_decay: 0.8 })).verdict).toBe("robust")
  })
})

describe("robust workflow qualification", () => {
  const positive = {
    totalReturn: 0.01,
    stitchedOosReturn: 0.005,
    alpha: 0.02,
  }

  test("requires the deterministic promotion verdict in addition to all positive performance gates", () => {
    expect(isRobustQualifiedResult({ verdict: "recommended_for_paper", ...positive })).toBeTrue()
    expect(isRobustQualifiedResult({ verdict: "failed", ...positive })).toBeFalse()
    expect(isRobustQualifiedResult({ verdict: "candidate", ...positive })).toBeFalse()
  })

  test("fails closed for zero, negative, missing, or non-finite performance", () => {
    for (const override of [
      { totalReturn: 0 },
      { stitchedOosReturn: -0.001 },
      { alpha: undefined },
      { alpha: Number.NaN },
    ]) {
      expect(isRobustQualifiedResult({ verdict: "recommended_for_paper", ...positive, ...override })).toBeFalse()
    }
  })

  test("keeps positive-but-unqualified runs active and defensively downgrades an inconsistent promotion claim", () => {
    expect(enforceRobustWorkflowVerdict({ verdict: "failed", ...positive })).toBe("failed")
    expect(enforceRobustWorkflowVerdict({ verdict: "recommended_for_paper", ...positive, stitchedOosReturn: 0 })).toBe("candidate")
    expect(enforceRobustWorkflowVerdict({ verdict: "recommended_for_paper", ...positive })).toBe("recommended_for_paper")
  })
})
