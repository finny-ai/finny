import type { BacktestRunner } from "./runner"

export type BacktestQualityLabel = "failed" | "weak_positive" | "candidate" | "paper_eligible"

export interface BacktestQuality {
  label: BacktestQualityLabel
  paperEligible: boolean
  reasons: string[]
  minTrades: number
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function dynamicMinTrades(results: BacktestRunner.Results): number {
  const bars = finite(results.diagnostics?.barsProcessed ?? results.v2?.bars_processed, 0)
  if (bars <= 0) return 30
  return Math.max(3, Math.min(30, Math.floor(bars * 0.01)))
}

export function evaluateBacktestQuality(results: BacktestRunner.Results): BacktestQuality {
  const reasons: string[] = []
  const minTrades = dynamicMinTrades(results)
  const repaired = results.v2?.data_quality?.repair_applied === true
  const wf = results.v2?.walk_forward
  const mc = results.v2?.monte_carlo
  const profitFactor = results.profitFactor

  if (results.totalReturn <= 0) reasons.push("return <= 0")
  if (results.sharpeRatio <= 0) reasons.push("Sharpe <= 0")
  if (results.maxDrawdown >= 0.5) reasons.push("max drawdown >= 50%")
  if (repaired) reasons.push("uses repaired data")

  if (reasons.length > 0) {
    return { label: "failed", paperEligible: false, reasons, minTrades }
  }

  if (results.totalTrades < minTrades)
    reasons.push(`trade count low for this window (${results.totalTrades} trades) — confidence limited`)
  if (results.sharpeRatio < 1) reasons.push("Sharpe < 1.0")
  if (results.maxDrawdown > 0.15) reasons.push("max drawdown > 15%")
  if (profitFactor != null && profitFactor < 1.5) reasons.push("profit factor < 1.5")
  if (wf) {
    const oosTrades = finite(wf.stitched_oos_trades, 0)
    const oosCoverage = finite(wf.stitched_oos_coverage, 0)
    if (wf.flagged) reasons.push("rolling OOS validation flagged")
    if (finite(wf.stitched_oos_return, -Infinity) <= 0) reasons.push("stitched OOS return <= 0")
    if (finite(wf.stitched_oos_sharpe ?? wf.oos_sharpe_mean, -Infinity) <= 0) reasons.push("stitched OOS Sharpe <= 0")
    if (oosTrades < minTrades) reasons.push(`stitched OOS trade count low (${oosTrades} trades)`)
    if (oosCoverage < 0.95) reasons.push(`stitched OOS coverage < 95% (${(oosCoverage * 100).toFixed(1)}%)`)
    if (finite(wf.ruined_folds, 0) > 0) reasons.push("one or more OOS folds were ruined")
  }
  if (mc && finite(mc.max_dd_p99, 0) <= -0.5) reasons.push("stressed profile breaches 50% drawdown ceiling")

  if (reasons.length > 0) {
    return { label: "weak_positive", paperEligible: false, reasons, minTrades }
  }

  if (!wf) {
    return {
      label: "candidate",
      paperEligible: false,
      reasons: ["walk-forward robustness not run"],
      minTrades,
    }
  }

  return { label: "paper_eligible", paperEligible: true, reasons: [], minTrades }
}
