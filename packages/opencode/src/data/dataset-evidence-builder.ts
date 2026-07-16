import crypto from "node:crypto"
import type { WorkspaceRequestContext } from "@/agent/finny-workspace-context"
import { normalizeInterval, normalizeSymbol } from "@/agent/request-identity"
import { DATASET_CALENDAR_VERSION, expectedEvidenceTimestamps } from "./dataset-evidence-calendar"
import {
  DATASET_EVIDENCE_SCHEMA,
  DATASET_EVIDENCE_VERSION,
  normalizedCsvSemanticHash,
  validateDatasetEvidenceV2,
  type DatasetEvidenceV2,
  type EvidenceCsvFacts,
} from "./dataset-evidence-v2"

const REQUIRED_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"] as const

type ProviderInput = DatasetEvidenceV2["provider"] & { providerSymbol: string }

export type BuiltDatasetEvidenceManifest = DatasetEvidenceV2 & {
  schema_version: 2
  source: string
  symbols: string[]
  requested_symbol: string
  actual_symbol: string
  requested_interval: string
  actual_interval: string
  requested_asset_class: string
  actual_asset_class: string
  requested_algorithm_name: string
  requested_start: string
  requested_end: string
  actual_start: string
  actual_end: string
  output_path: string
  rows: number
  run_id: string
  request_id: string
  request_version: number
  request_content_hash: string
  coverage: string
  coverage_note: string
  usable_for_parent: "yes" | "no"
  analysis_summary_path?: string
  analysis_regime?: string
  analysis_hypotheses?: string[]
}

export interface BuildDatasetEvidenceV2Input {
  csvBytes: Uint8Array
  csvText: string
  request: WorkspaceRequestContext
  workspaceSlug: string
  outputPath: string
  canonicalSymbol?: string
  provider: ProviderInput
  priceBasis: DatasetEvidenceV2["price_basis"]
  analysisSummaryPath?: string
  analysisRegime?: string
  analysisHypotheses?: string[]
  now?: Date
}

export interface BuiltDatasetEvidence {
  manifest: BuiltDatasetEvidenceManifest
  csvFacts: EvidenceCsvFacts
}

type ParsedBar = {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type Column = (typeof REQUIRED_COLUMNS)[number]
type ColumnIndexes = Record<Column, number>

type RequestBinding = {
  symbol: string
  assetClass: "crypto" | "equity"
  interval: string
  requestedStart: string
  requestedEnd: string
  requestVersion: number
  requestHash: string
}

type TimestampReconciliation = {
  expected: number[]
  actualSet: Set<number>
  missing: number[]
  extra: number[]
  step: number
  openFinalCandle: boolean
}

type Qualification = {
  outliers: number
  zeroVolume: number
  reasonCodes: string[]
  hardBlocked: boolean
  status: DatasetEvidenceV2["qualification"]["status"]
  coverage: string
  coverageNote: string
  usableForParent: "yes" | "no"
}

type EvidenceIdentity = {
  bytesHash: string
  identityHash: string
}

function sha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function epochMillis(raw: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return Date.parse(raw)
  const numeric = Number(raw)
  if (numeric >= 1e17) return numeric / 1e6
  if (numeric >= 1e14) return numeric / 1e3
  if (numeric >= 1e11) return numeric
  return numeric >= 1e9 ? numeric * 1_000 : Number.NaN
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function columnIndexes(headerLine: string): ColumnIndexes {
  const header = headerLine.split(",").map((part) => part.trim().toLowerCase())
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column))
  invariant(missing.length === 0, `CSV missing required columns: ${missing.join(", ")}`)
  return {
    timestamp: header.indexOf("timestamp"),
    open: header.indexOf("open"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    close: header.indexOf("close"),
    volume: header.indexOf("volume"),
  }
}

function parseBar(line: string, indexes: ColumnIndexes): ParsedBar {
  const cells = line.split(",")
  const timestamp = epochMillis(cells[indexes.timestamp]?.trim() ?? "")
  const [open, high, low, close, volume] = [
    indexes.open,
    indexes.high,
    indexes.low,
    indexes.close,
    indexes.volume,
  ].map((position) => Number(cells[position]))
  invariant(
    [timestamp, open, high, low, close, volume].every(Number.isFinite),
    "CSV has an invalid timestamp or numeric OHLCV row",
  )
  invariant(high >= low && high >= Math.max(open, close) && low <= Math.min(open, close), "CSV has an invalid OHLC row")
  invariant(volume >= 0, "CSV has invalid negative volume")
  return { timestamp, open, high, low, close, volume }
}

function assertOrderedUnique(bars: ParsedBar[]): void {
  const timestamps = bars.map((bar) => bar.timestamp)
  const uniqueCount = new Set(timestamps).size
  invariant(uniqueCount === timestamps.length, `CSV has ${timestamps.length - uniqueCount} duplicate timestamps`)
  const unordered = timestamps.some((timestamp, index) => index > 0 && timestamp <= timestamps[index - 1])
  invariant(!unordered, "CSV timestamps are not strictly increasing")
}

function parseCsv(csvText: string): { bars: ParsedBar[]; facts: EvidenceCsvFacts } {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim())
  invariant(lines.length > 1, "CSV is header-only or empty")
  const indexes = columnIndexes(lines[0])
  const bars = lines.slice(1).map((line) => parseBar(line, indexes))
  assertOrderedUnique(bars)
  return {
    bars,
    facts: {
      rows: bars.length,
      uniqueTimestamps: bars.length,
      duplicates: 0,
      invalidRows: 0,
      invalidOhlc: 0,
    },
  }
}

function calendar(assetClass: string): DatasetEvidenceV2["calendar"] {
  if (assetClass === "crypto") {
    return {
      id: "24/7",
      version: DATASET_CALENDAR_VERSION,
      timezone: "UTC",
      session_type: "continuous",
      half_day_policy: "none",
    }
  }
  return {
    id: "XNYS",
    version: DATASET_CALENDAR_VERSION,
    timezone: "America/New_York",
    session_type: "regular",
    half_day_policy: "scheduled_early_close",
  }
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(".000Z", "Z")
}

function timestampRanges(values: number[], step: number): Array<{ start: string; end: string; count: number }> {
  if (!values.length) return []
  const ranges: Array<{ start: string; end: string; count: number }> = []
  let start = values[0]
  let previous = start
  let count = 1
  for (const value of values.slice(1)) {
    if (value === previous + step) {
      previous = value
      count += 1
      continue
    }
    ranges.push({ start: iso(start), end: iso(previous), count })
    start = value
    previous = value
    count = 1
  }
  ranges.push({ start: iso(start), end: iso(previous), count })
  return ranges
}

function intervalMilliseconds(interval: string): number {
  const match = interval.match(/^(\d+)(m|h|d)$/)
  if (!match) throw new Error(`unsupported evidence interval: ${interval}`)
  const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
  const unit = units[match[2]]
  invariant(unit !== undefined, `unsupported evidence interval unit: ${match[2]}`)
  return Number(match[1]) * unit
}

function outlierCount(bars: ParsedBar[]): number {
  if (bars.length < 4) return 0
  const returns = bars.slice(1).map((bar, index) => Math.log(bar.close / bars[index].close))
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length
  const deviation = Math.sqrt(variance)
  if (!Number.isFinite(deviation) || deviation === 0) return 0
  return returns.filter((value) => Math.abs(value - mean) / deviation > 8).length
}

function required(input: { value: string | number | undefined; label: string }): string {
  invariant(input.value !== undefined && String(input.value).trim() !== "", `request context missing ${input.label}`)
  return String(input.value)
}

function allowedSymbols(request: WorkspaceRequestContext): string[] {
  return (request.requested_symbols?.length ? request.requested_symbols : [request.requested_symbol])
    .map((value) => normalizeSymbol(value))
    .filter((value): value is string => Boolean(value))
}

function selectedSymbol(input: { request: WorkspaceRequestContext; requested?: string }): string {
  const allowed = allowedSymbols(input.request)
  invariant(allowed.length > 0, "request context missing symbol")
  const selected = normalizeSymbol(input.requested) ?? (allowed.length === 1 ? allowed[0] : undefined)
  invariant(selected !== undefined, "canonicalSymbol is required for a multi-symbol request")
  invariant(allowed.includes(selected), `symbol ${selected} is outside the bound request universe`)
  return selected
}

function algorithmName(input: { request: WorkspaceRequestContext; workspaceSlug: string }): string {
  return input.request.requested_algorithm_name?.trim() || input.workspaceSlug.split(".")[0]
}

function bindRequest(input: BuildDatasetEvidenceV2Input): RequestBinding {
  const assetClass = required({ value: input.request.requested_asset_class, label: "asset_class" })
  invariant(assetClass === "crypto" || assetClass === "equity", `unsupported asset class: ${assetClass}`)
  const interval = normalizeInterval(required({ value: input.request.requested_interval, label: "interval" }))
  invariant(interval !== undefined, "request context has invalid interval")
  return {
    symbol: selectedSymbol({ request: input.request, requested: input.canonicalSymbol }),
    assetClass,
    interval,
    requestedStart: required({ value: input.request.requested_start, label: "start date" }),
    requestedEnd: required({ value: input.request.requested_end, label: "end date" }),
    requestVersion: Number(required({ value: input.request.request_version, label: "request_version" })),
    requestHash: required({ value: input.request.request_content_hash, label: "request_content_hash" }),
  }
}

function isOpenFinalCandle(input: {
  missing: number[]
  extra: number[]
  expected: number[]
  requestedEnd: string
  now: Date
}): boolean {
  return (
    input.missing.length === 1 &&
    input.extra.length === 0 &&
    input.missing[0] === input.expected.at(-1) &&
    input.requestedEnd === input.now.toISOString().slice(0, 10)
  )
}

function reconcileTimestamps(
  input: BuildDatasetEvidenceV2Input,
  binding: RequestBinding,
  bars: ParsedBar[],
): TimestampReconciliation {
  const evidenceCalendar = calendar(binding.assetClass)
  const expected = expectedEvidenceTimestamps({
    calendarId: evidenceCalendar.id,
    sessionType: evidenceCalendar.session_type,
    interval: binding.interval,
    requestedStartInclusive: binding.requestedStart,
    requestedEndInclusive: binding.requestedEnd,
  })
  const actual = bars.map((bar) => bar.timestamp)
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter((timestamp) => !actualSet.has(timestamp))
  const extra = actual.filter((timestamp) => !expectedSet.has(timestamp))
  return {
    expected,
    actualSet,
    missing,
    extra,
    step: intervalMilliseconds(binding.interval),
    openFinalCandle: isOpenFinalCandle({
      missing,
      extra,
      expected,
      requestedEnd: binding.requestedEnd,
      now: input.now ?? new Date(),
    }),
  }
}

function qualificationStatus(input: {
  hardBlocked: boolean
  reasonCodes: string[]
}): DatasetEvidenceV2["qualification"]["status"] {
  if (input.hardBlocked) return "blocked"
  return input.reasonCodes.length ? "research_only" : "strict_qualified"
}

function coverageDescription(input: {
  openFinalCandle: boolean
  hardBlocked: boolean
  missingCount: number
  extraCount: number
}): Pick<Qualification, "coverage" | "coverageNote"> {
  if (input.openFinalCandle) {
    return {
      coverage: "partial_current_open_candle",
      coverageNote: "partial because the current requested candle is still open and not yet available",
    }
  }
  if (input.hardBlocked) {
    return {
      coverage: "partial",
      coverageNote: `partial: missing=${input.missingCount}, extra=${input.extraCount}`,
    }
  }
  return { coverage: "full", coverageNote: "full requested calendar coverage" }
}

function qualifyEvidence(
  input: BuildDatasetEvidenceV2Input,
  bars: ParsedBar[],
  reconciliation: TimestampReconciliation,
): Qualification {
  const outliers = outlierCount(bars)
  const zeroVolume = bars.filter((bar) => bar.volume === 0).length
  const reasons: Array<[boolean, string]> = [
    [reconciliation.openFinalCandle, "INCOMPLETE_FINAL_BAR"],
    [!reconciliation.openFinalCandle && reconciliation.missing.length > 0, "MISSING_EXPECTED_TIMESTAMP"],
    [reconciliation.extra.length > 0, "EXTRA_TIMESTAMP"],
    [outliers > 0, "OUTLIER"],
    [zeroVolume > 0, "ZERO_VOLUME"],
    [input.priceBasis.basis === "unknown", "UNKNOWN_PRICE_BASIS"],
    [input.priceBasis.corporate_action_status === "unresolved", "UNRESOLVED_CORPORATE_ACTIONS"],
  ]
  const reasonCodes = reasons.filter(([applies]) => applies).map(([, code]) => code)
  const hardBlocked =
    (reconciliation.missing.length > 0 && !reconciliation.openFinalCandle) || reconciliation.extra.length > 0
  return {
    outliers,
    zeroVolume,
    reasonCodes,
    hardBlocked,
    status: qualificationStatus({ hardBlocked, reasonCodes }),
    ...coverageDescription({
      openFinalCandle: reconciliation.openFinalCandle,
      hardBlocked,
      missingCount: reconciliation.missing.length,
      extraCount: reconciliation.extra.length,
    }),
    usableForParent: hardBlocked ? "no" : "yes",
  }
}

function evidenceIdentity(input: BuildDatasetEvidenceV2Input, binding: RequestBinding): EvidenceIdentity {
  const bytesHash = sha256(input.csvBytes)
  const seed = JSON.stringify({
    requestHash: binding.requestHash,
    bytesHash,
    provider: input.provider,
    symbol: binding.symbol,
    interval: binding.interval,
    outputPath: input.outputPath,
  })
  return { bytesHash, identityHash: sha256(seed) }
}

type ManifestAssemblyInput = {
  source: BuildDatasetEvidenceV2Input
  binding: RequestBinding
  bars: ParsedBar[]
  facts: EvidenceCsvFacts
  reconciliation: TimestampReconciliation
  qualification: Qualification
  identity: EvidenceIdentity
}

function canonicalManifestFields(input: ManifestAssemblyInput) {
  const { source, binding, bars, facts, reconciliation, qualification, identity } = input
  const first = bars[0].timestamp
  const last = bars.at(-1)!.timestamp
  return {
    schema: DATASET_EVIDENCE_SCHEMA,
    version: DATASET_EVIDENCE_VERSION,
    evidence_id: `dsv2_${identity.identityHash.slice(0, 24)}`,
    provider: { id: source.provider.id, feed: source.provider.feed, venue: source.provider.venue },
    instrument: {
      asset_class: binding.assetClass,
      canonical_symbol: binding.symbol,
      provider_symbol: source.provider.providerSymbol,
    },
    interval: binding.interval,
    calendar: calendar(binding.assetClass),
    window: {
      requested_start_inclusive: binding.requestedStart,
      requested_end_inclusive: binding.requestedEnd,
      actual_start_inclusive: iso(first),
      actual_end_inclusive: iso(last),
    },
    timestamps: {
      expected_count: reconciliation.expected.length,
      actual_count: reconciliation.actualSet.size,
      missing_count: reconciliation.missing.length,
      extra_count: reconciliation.extra.length,
      missing_ranges: timestampRanges(reconciliation.missing, reconciliation.step),
      extra_ranges: timestampRanges(reconciliation.extra, reconciliation.step),
    },
    quality: {
      duplicate_count: facts.duplicates,
      ohlc_violation_count: facts.invalidOhlc,
      outlier_count: qualification.outliers,
      zero_volume_count: qualification.zeroVolume,
      invalid_volume_count: 0,
      incomplete_final_bar_count: reconciliation.openFinalCandle ? 1 : 0,
    },
    price_basis: source.priceBasis,
    hashes: {
      raw_bytes_sha256: identity.bytesHash,
      normalized_semantic_sha256: normalizedCsvSemanticHash(source.csvText),
      processed_bytes_sha256: identity.bytesHash,
      transformation_versions: { normalization: "finny-ohlcv-1", calendar: DATASET_CALENDAR_VERSION },
    },
    repair_lineage: null,
    qualification: { status: qualification.status, reason_codes: qualification.reasonCodes },
  }
}

function legacyManifestFields(input: ManifestAssemblyInput) {
  const { source, binding, bars, qualification, identity } = input
  const first = bars[0].timestamp
  const last = bars.at(-1)!.timestamp
  return {
    schema_version: 2 as const,
    source: source.provider.id,
    symbols: [binding.symbol],
    requested_symbol: binding.symbol,
    actual_symbol: binding.symbol,
    requested_interval: binding.interval,
    actual_interval: binding.interval,
    requested_asset_class: binding.assetClass,
    actual_asset_class: binding.assetClass,
    requested_algorithm_name: algorithmName({ request: source.request, workspaceSlug: source.workspaceSlug }),
    requested_start: binding.requestedStart,
    requested_end: binding.requestedEnd,
    actual_start: iso(first),
    actual_end: iso(last),
    output_path: source.outputPath.replaceAll("\\", "/"),
    rows: bars.length,
    run_id: `data_${identity.identityHash.slice(0, 16)}`,
    request_id: source.request.request_id,
    request_version: binding.requestVersion,
    request_content_hash: binding.requestHash,
    coverage: qualification.coverage,
    coverage_note: qualification.coverageNote,
    usable_for_parent: qualification.usableForParent,
  }
}

function optionalAnalysisFields(source: BuildDatasetEvidenceV2Input) {
  return {
    ...(source.analysisSummaryPath ? { analysis_summary_path: source.analysisSummaryPath } : {}),
    ...(source.analysisRegime ? { analysis_regime: source.analysisRegime } : {}),
    ...(source.analysisHypotheses?.length ? { analysis_hypotheses: source.analysisHypotheses } : {}),
  }
}

function assembleManifest(input: ManifestAssemblyInput): BuiltDatasetEvidenceManifest {
  return {
    ...canonicalManifestFields(input),
    ...legacyManifestFields(input),
    ...optionalAnalysisFields(input.source),
  }
}

export function buildDatasetEvidenceV2(input: BuildDatasetEvidenceV2Input): BuiltDatasetEvidence {
  const { bars, facts } = parseCsv(input.csvText)
  const binding = bindRequest(input)
  const reconciliation = reconcileTimestamps(input, binding, bars)
  const qualification = qualifyEvidence(input, bars, reconciliation)
  const identity = evidenceIdentity(input, binding)
  const manifest = assembleManifest({ source: input, binding, bars, facts, reconciliation, qualification, identity })
  const issues = validateDatasetEvidenceV2({
    manifest,
    csvBytes: input.csvBytes,
    csvText: input.csvText,
    csvFacts: facts,
  })
  invariant(issues.length === 0, `runtime generated invalid DatasetEvidenceV2: ${issues.join("; ")}`)
  return { manifest, csvFacts: facts }
}
