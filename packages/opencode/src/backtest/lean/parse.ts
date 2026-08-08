import type { CrucibleResultV1, LeanRunArtifactsV1 } from "./types"

/**
 * Default canonicalizer from LEAN artifacts into CrucibleResultV1. Raw LEAN
 * statistics are evidence-only: they are surfaced in the result blob but the
 * qualification gates only consume the canonical fields below.
 */
export function canonicalizeLeanArtifacts(input: {
  artifacts: LeanRunArtifactsV1
  startingEquity: number
  engineVersion: string
}): CrucibleResultV1 {
  const stats = (input.artifacts.rawStatistics ?? {}) as Record<string, unknown>
  const num = (key: string): number => {
    const value = stats[key]
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""))
    return Number.isFinite(parsed) ? parsed : 0
  }
  const endingEquity = num("Final Equity") || num("Ending Equity") || input.startingEquity
  const totalTrades = Math.max(0, Math.round(num("Total Orders")))
  const fees = num("Total Fees")
  const navCurve = input.artifacts.equityCurve.length
    ? input.artifacts.equityCurve
    : [{ timestamp: new Date().toISOString(), equity: endingEquity }]
  return {
    schema: "finny.crucible_result",
    version: 1,
    runtimeProfileId: "lean_python",
    startingEquity: input.startingEquity,
    endingEquity,
    totalReturn: num("Net Profit"),
    maxDrawdown: num("Drawdown"),
    annualizedVolatility: num("Annual Standard Deviation"),
    sharpeRatio: num("Sharpe Ratio"),
    totalTrades,
    winRate: totalTrades > 0 ? num("Win Rate") / 100 : 0,
    profitFactor: stats["Profit-Loss Ratio"] === undefined ? null : num("Profit-Loss Ratio"),
    fees,
    slippage: 0,
    exposure: 0,
    navCurve,
    orders: input.artifacts.orders,
    fills: input.artifacts.fills,
    rejections: input.artifacts.rejections,
    diagnostics: {
      barsProcessed: 0,
      rejectedOrders: input.artifacts.rejections.length,
      pendingOrdersAtEnd: 0,
      strategyErrors: 0,
    },
    engineVersion: input.engineVersion,
    runKind: "crucible_2_0",
  }
}
