import type { BacktestRunner } from "./runner"
import { qualificationInputErrors, type QualificationInputV1 } from "./qualification-policy"

export type BacktestQualityLabel = "failed" | "inconclusive" | "weak_positive" | "candidate" | "paper_eligible"

export interface BacktestQuality {
  label: BacktestQualityLabel
  paperEligible: boolean
  reasons: string[]
  minTrades: number
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function realizedPnl(results: BacktestRunner.Results): number | undefined {
  if (typeof results.realizedPnl === "number" && Number.isFinite(results.realizedPnl)) return results.realizedPnl
  const trades = results.v2?.trades ?? []
  if (trades.length === 0) return undefined
  return trades.reduce((sum, trade) => sum + finite(trade.pnl, 0), 0)
}

function unrealizedPnl(results: BacktestRunner.Results): number | undefined {
  if (typeof results.unrealizedPnl === "number" && Number.isFinite(results.unrealizedPnl)) return results.unrealizedPnl
  const openTrades = results.v2?.open_trades ?? []
  if (openTrades.length === 0) return undefined
  return openTrades.reduce((sum, trade) => sum + finite(trade.unrealized_pnl, 0), 0)
}

export function dynamicMinTrades(results: BacktestRunner.Results): number {
  const bars = finite(results.diagnostics?.barsProcessed ?? results.v2?.bars_processed, 0)
  if (bars <= 0) return 30
  return Math.max(3, Math.min(30, Math.floor(bars * 0.01)))
}

export function evaluateBacktestQuality(
  results: BacktestRunner.Results,
  qualification: QualificationInputV1,
): BacktestQuality {
  const policy = qualification.policy
  const qualificationReasons = qualificationInputErrors(qualification)
  const reasons: string[] = []
  const minTrades = Math.max(dynamicMinTrades(results), policy.minTrades, policy.minEffectiveSampleSize)
  const repaired =
    results.v2?.data_quality?.repair_applied === true || qualification.context.dataQualityMode === "repair_outliers"
  const wf = results.v2?.walk_forward
  const mc = results.v2?.monte_carlo
  const profitFactor = results.profitFactor
  const liquidationNav = (results.v2?.run_metadata as any)?.liquidation_nav
  const liquidationAdjustedReturn =
    typeof liquidationNav?.nav === "number" && typeof results.v2?.starting_equity === "number"
      ? (liquidationNav.nav - results.v2.starting_equity) / results.v2.starting_equity
      : results.totalReturn
  const terminalDrawdown =
    typeof liquidationNav?.nav === "number" && typeof results.v2?.starting_equity === "number"
      ? Math.max(0, (results.v2.starting_equity - liquidationNav.nav) / results.v2.starting_equity)
      : results.maxDrawdown
  const liquidationAdjustedDrawdown = Math.max(results.maxDrawdown, terminalDrawdown)
  const benchmarkReturn = finite(results.benchmarkReturn, Number.NaN)
  const alpha =
    typeof results.alpha === "number" && Number.isFinite(results.alpha)
      ? results.alpha
      : Number.isFinite(benchmarkReturn)
        ? results.totalReturn - benchmarkReturn
        : Number.NaN
  const benchmarkSharpe = finite(results.benchmarkSharpeRatio, Number.NaN)
  const benchmarkDrawdown = finite(results.benchmarkMaxDrawdown, Number.NaN)
  const strictRun = results.runKind === "crucible_2_0" || results.productLabel === "Crucible 2.0"
  const requiresBenchmark = strictRun || policy.requireBenchmark
  const drawdownTrigger = results.v2?.diagnostics?.drawdown_trigger
  const executionConfig = results.v2?.execution_config
  const riskContract = executionConfig?.risk_contract
  const researchOnlyRisk =
    results.runKind === "legacy" ||
    (strictRun &&
      executionConfig !== undefined &&
      (riskContract === undefined ||
        riskContract.sizing_stop_distance_pct == null ||
        riskContract.drawdown?.limit_pct == null ||
        riskContract.max_positions == null))

  if (liquidationAdjustedReturn <= 0) reasons.push("liquidation-adjusted return <= 0")
  if (requiresBenchmark && !Number.isFinite(benchmarkReturn)) reasons.push("buy-and-hold benchmark unavailable")
  if (policy.requirePositiveAlpha && !Number.isFinite(alpha)) reasons.push("alpha vs buy-and-hold unavailable")
  if (policy.requirePositiveAlpha && Number.isFinite(alpha) && alpha <= 0) reasons.push("alpha vs buy-and-hold <= 0")
  if (results.sharpeRatio <= 0) reasons.push("Sharpe <= 0")
  if (liquidationAdjustedDrawdown > policy.maxDrawdown)
    reasons.push(`liquidation-adjusted max drawdown > ${(policy.maxDrawdown * 100).toFixed(0)}%`)
  if (repaired) reasons.push("uses repaired data")
  if (drawdownTrigger && typeof drawdownTrigger === "object") reasons.push("drawdown risk contract triggered")

  if (reasons.length > 0) {
    return { label: "failed", paperEligible: false, reasons: [...qualificationReasons, ...reasons], minTrades }
  }

  if (results.totalTrades < minTrades) {
    reasons.push(`closed trade count below minimum for this window (${results.totalTrades} < ${minTrades})`)
  }
  const realized = realizedPnl(results)
  const unrealized = unrealizedPnl(results)
  if (results.totalReturn > 0 && realized !== undefined && realized <= 0 && finite(unrealized, 0) > 0) {
    reasons.push("positive total return depends on open unrealized PnL while realized PnL is nonpositive")
  }
  if (reasons.length > 0) {
    return {
      label: qualificationReasons.length ? "failed" : "inconclusive",
      paperEligible: false,
      reasons: [...qualificationReasons, ...reasons],
      minTrades,
    }
  }

  if (results.sharpeRatio < 1) reasons.push("Sharpe < 1.0")
  if (strictRun && Number.isFinite(benchmarkSharpe) && results.sharpeRatio <= benchmarkSharpe)
    reasons.push("Sharpe <= buy-and-hold Sharpe")
  if (liquidationAdjustedDrawdown > 0.15) reasons.push("liquidation-adjusted max drawdown > 15%")
  if (Number.isFinite(benchmarkDrawdown) && benchmarkDrawdown > 0 && liquidationAdjustedDrawdown >= benchmarkDrawdown)
    reasons.push("max drawdown >= buy-and-hold max drawdown")
  if (profitFactor != null && profitFactor < 1.5) reasons.push("profit factor < 1.5")
  if (wf) {
    const oosTrades = finite(wf.stitched_oos_trades, 0)
    const oosCoverage = finite(wf.stitched_oos_coverage, 0)
    if (wf.flagged) reasons.push("rolling OOS validation flagged")
    if (finite(wf.is_sharpe_mean, Number.NEGATIVE_INFINITY) <= 0) reasons.push("walk-forward IS Sharpe <= 0")
    if (wf.oos_decay === null || !Number.isFinite(wf.oos_decay)) reasons.push("walk-forward OOS decay unavailable")
    if (finite(wf.stitched_oos_return, -Infinity) <= 0) reasons.push("stitched OOS return <= 0")
    if (finite(wf.stitched_oos_sharpe ?? wf.oos_sharpe_mean, -Infinity) <= 0) reasons.push("stitched OOS Sharpe <= 0")
    if (oosTrades < minTrades) reasons.push(`stitched OOS trade count low (${oosTrades} trades)`)
    const minimumCoverage = policy.minOosCoverage
    if (oosCoverage < minimumCoverage)
      reasons.push(
        `stitched OOS coverage < ${(minimumCoverage * 100).toFixed(0)}% (${(oosCoverage * 100).toFixed(1)}%)`,
      )
    if (finite(wf.ruined_folds, 0) > 0) reasons.push("one or more OOS folds were ruined")
    if (finite(wf.deflated_sharpe, -Infinity) < policy.minDeflatedSharpe) {
      reasons.push(`deflated Sharpe probability < ${policy.minDeflatedSharpe.toFixed(2)}`)
    }
    if (finite(wf.probabilistic_sharpe, -Infinity) < policy.minProbabilisticSharpe) {
      reasons.push(`probabilistic Sharpe probability < ${policy.minProbabilisticSharpe.toFixed(2)}`)
    }
  }
  if (mc && finite(mc.max_dd_p99, 0) <= -policy.maxStressDrawdown)
    reasons.push("stressed profile breaches drawdown ceiling")
  if (policy.requireCostSensitivity) {
    const costSensitivity = results.sensitivityOutcomes?.find((item) => /cost|fee|slippage/i.test(item.name))
    if (!costSensitivity || costSensitivity.status !== "pass") reasons.push("configured cost sensitivity did not pass")
  }
  if (policy.minWalkForwardFolds > 0 && (!wf || finite(wf.n_folds, 0) < policy.minWalkForwardFolds)) {
    reasons.push(`walk-forward folds < ${policy.minWalkForwardFolds}`)
  }
  if (policy.requireRiskContract && researchOnlyRisk) reasons.push("legacy/v3 risk contract is research-only")
  reasons.push(...qualificationReasons)

  if (reasons.length > 0) {
    return { label: qualificationReasons.length ? "failed" : "weak_positive", paperEligible: false, reasons, minTrades }
  }

  if (!wf) {
    const candidateReasons = ["walk-forward robustness not run"]
    if (researchOnlyRisk) candidateReasons.push("legacy/v3 risk contract is research-only")
    return {
      label: "candidate",
      paperEligible: false,
      reasons: candidateReasons,
      minTrades,
    }
  }

  if (researchOnlyRisk) {
    return {
      label: "candidate",
      paperEligible: false,
      reasons: ["legacy/v3 risk contract is research-only"],
      minTrades,
    }
  }

  return { label: "paper_eligible", paperEligible: true, reasons: [], minTrades }
}
