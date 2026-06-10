import type { DataQualityFailureMetadata } from "@/tool/backtest-run"

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

  return lines.join("\n")
}
