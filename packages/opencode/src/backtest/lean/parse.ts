import type { CrucibleResultV1, LeanRunArtifactsV1 } from "./types"
import { leanStatisticNumber } from "./lean-result-parse"

/**
 * Default canonicalizer from LEAN artifacts into CrucibleResultV1. Raw LEAN
 * statistics are evidence-only: they are surfaced in the result blob but the
 * qualification gates only consume the canonical fields below.
 */
export function canonicalizeLeanArtifacts(input: {
  artifacts: LeanRunArtifactsV1
  startingEquity: number
  engineVersion: string
  runtimeProfileId: CrucibleResultV1["runtimeProfileId"]
}): CrucibleResultV1 {
  const stats = (input.artifacts.rawStatistics ?? {}) as Record<string, unknown>
  // LEAN statistics are formatted strings: percentages like "-38.303%",
  // currency like "$220.00", and bare decimals for ratios/counts. The
  // canonicalizer normalizes them into Finny's numeric units (fractions for
  // returns/drawdowns/win rate, absolute dollars for fees/equity).
  const stat = (key: string): number | undefined => leanStatisticNumber(stats[key])
  // LEAN's StatisticsBuilder emits "End Equity" (e.g. "6169.65"); older
  // packets used "Final Equity"/"Ending Equity", kept as fallbacks.
  const endingEquity = stat("End Equity") ?? stat("Final Equity") ?? stat("Ending Equity") ?? input.startingEquity
  const totalTrades = Math.max(0, Math.round(stat("Total Orders") ?? 0))
  const fees = stat("Total Fees") ?? 0
  const navCurve = input.artifacts.equityCurve.length
    ? input.artifacts.equityCurve
    : [{ timestamp: new Date().toISOString(), equity: endingEquity }]
  return {
    schema: "finny.crucible_result",
    version: 1,
    runtimeProfileId: input.runtimeProfileId,
    startingEquity: input.startingEquity,
    endingEquity,
    totalReturn: stat("Net Profit") ?? 0,
    // LEAN's Drawdown statistic is a positive magnitude (e.g. 0.3841 for a
    // 38.41% peak-to-trough loss), matching the engine_v2 Results convention
    // that the qualification gates consume.
    maxDrawdown: stat("Drawdown") ?? 0,
    annualizedVolatility: stat("Annual Standard Deviation") ?? 0,
    sharpeRatio: stat("Sharpe Ratio") ?? 0,
    totalTrades,
    winRate: totalTrades > 0 ? (stat("Win Rate") ?? 0) : 0,
    profitFactor: stats["Profit-Loss Ratio"] === undefined ? null : (stat("Profit-Loss Ratio") ?? 0),
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
