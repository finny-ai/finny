/**
 * Shared strict data-quality vocabulary between the data extractor digest and
 * the engine_v2 strict backtest gate. Keep labels aligned so parent agents and
 * graders can correlate extractor reports with backtest blockers.
 */
export const STRICT_DATA_QUALITY_LABELS = [
  "duplicates",
  "gaps",
  "invalid_ohlc",
  "zero_volume",
  "outliers",
  "partial_provider_coverage",
] as const

export type StrictDataQualityLabel = (typeof STRICT_DATA_QUALITY_LABELS)[number]

export const OHLC_VALIDATION_RULE =
  "high >= max(open, close) and low <= min(open, close) with high >= low"

export function isValidOhlcBar(open: number, high: number, low: number, close: number): boolean {
  const bodyTop = Math.max(open, close)
  const bodyBottom = Math.min(open, close)
  return high >= low && high >= bodyTop && low <= bodyBottom
}

export const STRICT_DATA_QUALITY_VOCABULARY = STRICT_DATA_QUALITY_LABELS.join(" | ")
