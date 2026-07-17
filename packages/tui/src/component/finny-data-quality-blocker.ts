export type DataQualityFailureMetadata = {
  kind: "data_quality_failed"
  algorithmName: string
  params: { duration: string; interval: string; capital: string; dataQualityMode: "strict" | "repair_outliers" }
  phase?: "before_resample" | "after_resample"
  reason: string
  symbol?: string
  provider?: string
  interval?: string
  rawRows?: number
  postRows?: number
  repair_outliers_allowed: boolean
  outlierDetails: Array<{
    timestamp: string
    prev_close: number
    close: number
    log_return: number
    z_score: number
    provider?: string
  }>
}

function strictDataQualityNextSteps() {
  return [
    "No performance metrics were produced; do not call this strategy backtested, ready, or paper/live eligible.",
    "Valid next steps:",
    "1. Verify the flagged candles first: inspect neighboring raw candles and compare another provider if available.",
    "2. Ask the user before changing the backtest window, interval, provider, or data-quality strictness.",
    "3. Only after explicit user approval, run repair_outliers as a research-only rerun.",
  ].join("\n")
}

export function formatFinnyDataQualityBlocker(meta: DataQualityFailureMetadata) {
  const lines = [
    "Strict data quality blocked this backtest.",
    `Algorithm: ${meta.algorithmName}`,
    `Phase: ${meta.phase ?? "unknown"}`,
    `Reason: ${meta.reason}`,
  ]

  const context = [
    meta.symbol ? `symbol=${meta.symbol}` : undefined,
    meta.provider ? `provider=${meta.provider}` : undefined,
    meta.interval ? `interval=${meta.interval}` : undefined,
    meta.rawRows !== undefined ? `raw_rows=${meta.rawRows}` : undefined,
    meta.postRows !== undefined ? `post_rows=${meta.postRows}` : undefined,
  ].filter(Boolean)
  if (context.length > 0) lines.push(`Context: ${context.join(", ")}`)

  for (const detail of meta.outlierDetails) {
    lines.push(
      `Outlier: ts=${detail.timestamp} prev_close=${detail.prev_close} close=${detail.close} log_return=${detail.log_return} z=${detail.z_score} provider=${detail.provider ?? meta.provider ?? "unknown"}`,
    )
  }

  lines.push(
    meta.repair_outliers_allowed
      ? "Repair mode was explicitly requested; treat this as research-only until strict mode passes."
      : "Stopped without running repair_outliers.",
  )
  if (!meta.repair_outliers_allowed) lines.push("", strictDataQualityNextSteps())

  return lines.join("\n")
}
