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
  const profitFactor = results.profitFactor

  if (results.totalReturn <= 0) reasons.push("return <= 0")
  if (results.sharpeRatio <= 0) reasons.push("Sharpe <= 0")
  if (results.maxDrawdown >= 0.5) reasons.push("max drawdown >= 50%")
  if (repaired) reasons.push("uses repaired data")

  if (reasons.length > 0) {
    return { label: "failed", paperEligible: false, reasons, minTrades }
  }

  if (results.totalTrades < minTrades) reasons.push(`low sample size (${results.totalTrades}/${minTrades} trades)`)
  if (results.sharpeRatio < 1) reasons.push("Sharpe < 1.0")
  if (results.maxDrawdown > 0.15) reasons.push("max drawdown > 15%")
  if (profitFactor != null && profitFactor < 1.5) reasons.push("profit factor < 1.5")
  if (wf && (wf.flagged || finite(wf.oos_sharpe_mean, -Infinity) <= 0)) reasons.push("walk-forward failed")

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
