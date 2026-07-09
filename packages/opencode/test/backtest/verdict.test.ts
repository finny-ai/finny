import { describe, expect, test } from "bun:test"
import { composeBacktestVerdict, deriveWalkForwardVerdict } from "../../src/backtest/verdict"
import type { BacktestQuality } from "../../src/backtest/evaluation"

const weakQuality: BacktestQuality = {
  label: "weak_positive",
  paperEligible: false,
  reasons: ["Sharpe < 1.0"],
  minTrades: 3,
}

const candidateQuality: BacktestQuality = {
  label: "candidate",
  paperEligible: false,
  reasons: [],
  minTrades: 3,
}

const robustWf = { verdict: "robust" as const, reason: "robust" }
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
})
