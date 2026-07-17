import crypto from "node:crypto"
import { DATASET_CALENDAR_VERSION, expectedEvidenceTimestamps } from "./dataset-evidence-calendar"

export const DATASET_EVIDENCE_SCHEMA = "finny.dataset_evidence" as const
export const DATASET_EVIDENCE_VERSION = 2 as const

export type DatasetQualification = "strict_qualified" | "research_only" | "blocked" | "research_only_legacy"

export interface DatasetEvidenceV2 {
  schema: typeof DATASET_EVIDENCE_SCHEMA
  version: typeof DATASET_EVIDENCE_VERSION
  evidence_id: string
  provider: { id: string; feed: string; venue: string }
  instrument: {
    asset_class: string
    canonical_symbol: string
    provider_symbol: string
  }
  interval: string
  calendar: {
    id: string
    version: string
    timezone: string
    session_type: string
    half_day_policy: string
  }
  window: {
    requested_start_inclusive: string
    requested_end_inclusive: string
    actual_start_inclusive: string
    actual_end_inclusive: string
  }
  timestamps: {
    expected_count: number
    actual_count: number
    missing_count: number
    extra_count: number
    missing_ranges: Array<{ start: string; end: string; count: number }>
    extra_ranges?: Array<{ start: string; end: string; count: number }>
  }
  quality: {
    duplicate_count: number
    ohlc_violation_count: number
    outlier_count: number
    zero_volume_count: number
    invalid_volume_count: number
    incomplete_final_bar_count: number
  }
  price_basis: {
    basis: "raw" | "adjusted" | "unknown"
    split_treatment: string
    dividend_treatment: string
    corporate_action_status: "resolved" | "unresolved" | "not_applicable"
    events: Array<{
      type: "split" | "dividend" | "other"
      effective_at: string
      value?: number
      treatment: string
    }>
  }
  hashes: {
    raw_bytes_sha256: string
    normalized_semantic_sha256: string
    processed_bytes_sha256: string
    transformation_versions: Record<string, string>
  }
  repair_lineage?: {
    parent_evidence_id: string
    transformations: Array<{ name: string; version: string; affected_rows: number }>
    actor: string
    approval: string
  } | null
  qualification: {
    status: Exclude<DatasetQualification, "research_only_legacy">
    reason_codes: string[]
  }
}

export interface EvidenceCsvFacts {
  rows: number
  uniqueTimestamps: number
  duplicates: number
  invalidRows: number
  invalidOhlc: number
}

const HASH = /^(?:sha256:)?([a-f0-9]{64})$/i

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function normalizedHash(value: unknown): string | undefined {
  const match = text(value)?.match(HASH)
  return match?.[1]?.toLowerCase()
}

/** Stable semantic hash independent of line endings, header order, and numeric formatting. */
export function normalizedCsvSemanticHash(csvText: string): string {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return hashValue("")
  const header = lines[0].split(",").map((part) => part.trim().toLowerCase())
  const columns = ["timestamp", "open", "high", "low", "close", "volume"]
  const index = columns.map((column) => header.indexOf(column))
  if (index.some((position) => position < 0)) return hashValue(csvText)
  const semantic = lines.slice(1).map((line) => {
    const values = line.split(",")
    const parsed = new Date(values[index[0]].trim())
    const timestamp = Number.isNaN(parsed.getTime()) ? values[index[0]].trim() : parsed.toISOString()
    return [timestamp, ...index.slice(1).map((position) => String(Number(values[position])))].join(",")
  })
  return hashValue([columns.join(","), ...semantic].join("\n"))
}

function requiredTextIssues(value: Record<string, unknown>, fields: string[], prefix: string): string[] {
  return fields.flatMap((field) => (text(value[field]) ? [] : [`${prefix}.${field} is required`]))
}

function rangeIssues(ranges: unknown, label: string): string[] {
  if (!Array.isArray(ranges)) return [`timestamps.${label} must be an array`]
  return ranges.flatMap((range, index) => {
    if (!range || typeof range !== "object") return [`timestamps.${label}[${index}] must be an object`]
    const item = range as Record<string, unknown>
    const issues = requiredTextIssues(item, ["start", "end"], `timestamps.${label}[${index}]`)
    if (!nonnegativeInteger(item.count) || item.count === 0)
      issues.push(`timestamps.${label}[${index}].count must be positive`)
    return issues
  })
}

function hasStrictSafetyShape(evidence: DatasetEvidenceV2): boolean {
  return Boolean(
    evidence.timestamps &&
      evidence.quality &&
      evidence.price_basis &&
      evidence.qualification &&
      Array.isArray(evidence.qualification.reason_codes),
  )
}

function qualificationSafetyIssues(evidence: DatasetEvidenceV2): string[] {
  if (evidence.qualification.status !== "strict_qualified") return []
  const issues: string[] = []
  const counts: Array<[string, number]> = [
    ["missing timestamps", evidence.timestamps.missing_count],
    ["extra timestamps", evidence.timestamps.extra_count],
    ["duplicates", evidence.quality.duplicate_count],
    ["OHLC violations", evidence.quality.ohlc_violation_count],
    ["outliers", evidence.quality.outlier_count],
    ["zero volume bars", evidence.quality.zero_volume_count],
    ["invalid volume bars", evidence.quality.invalid_volume_count],
    ["incomplete final bars", evidence.quality.incomplete_final_bar_count],
  ]
  for (const [label, count] of counts) if (count > 0) issues.push(`strict_qualified evidence has ${count} ${label}`)
  if (evidence.price_basis.basis === "unknown") issues.push("strict_qualified evidence has unknown price basis")
  if (evidence.price_basis.corporate_action_status === "unresolved") {
    issues.push("strict_qualified evidence has unresolved corporate actions")
  }
  if (evidence.repair_lineage) issues.push("repaired evidence is permanently non-promotable")
  if (evidence.qualification.reason_codes.length > 0) issues.push("strict_qualified evidence must have no reason codes")
  return issues
}

function mirrorValueMatches(label: string, legacy: unknown, v2: unknown): boolean {
  if (label.startsWith("actual_start") || label.startsWith("actual_end")) {
    const left = Date.parse(String(legacy))
    return Number.isFinite(left) && left === Date.parse(String(v2))
  }
  return String(legacy).trim().toLowerCase() === String(v2).trim().toLowerCase()
}

type MirrorPair = [string, unknown, unknown]

function nestedField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return (value as Record<string, unknown>)[key]
}

function legacyMirrorIssue(pair: MirrorPair): string | undefined {
  const [label, legacy, v2] = pair
  if (legacy === undefined || v2 === undefined) return undefined
  return mirrorValueMatches(label, legacy, v2) ? undefined : `legacy mirror mismatch: ${label}`
}

function legacyMirrorIssues(manifest: Record<string, unknown>, evidence: DatasetEvidenceV2): string[] {
  const pairs: MirrorPair[] = [
    ["source/provider.id", manifest.source, nestedField(evidence.provider, "id")],
    [
      "actual_symbol/instrument.canonical_symbol",
      manifest.actual_symbol,
      nestedField(evidence.instrument, "canonical_symbol"),
    ],
    ["actual_interval/interval", manifest.actual_interval, evidence.interval],
    [
      "actual_asset_class/instrument.asset_class",
      manifest.actual_asset_class,
      nestedField(evidence.instrument, "asset_class"),
    ],
    [
      "actual_start/window.actual_start_inclusive",
      manifest.actual_start,
      nestedField(evidence.window, "actual_start_inclusive"),
    ],
    [
      "actual_end/window.actual_end_inclusive",
      manifest.actual_end,
      nestedField(evidence.window, "actual_end_inclusive"),
    ],
    ["rows/timestamps.actual_count", manifest.rows, nestedField(evidence.timestamps, "actual_count")],
  ]
  return pairs.map(legacyMirrorIssue).filter((issue): issue is string => Boolean(issue))
}

function csvTimestampSet(csvText: string): Set<number> {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim())
  const header = lines[0]?.split(",").map((part) => part.trim().toLowerCase()) ?? []
  const timestampIndex = header.indexOf("timestamp")
  if (timestampIndex < 0) return new Set()
  return new Set(
    lines
      .slice(1)
      .map((line) => parseEvidenceTimestamp(line.split(",")[timestampIndex]?.trim()))
      .filter(Number.isFinite),
  )
}

function parseEvidenceTimestamp(value?: string): number {
  if (!value) return Number.NaN
  if (!/^\d+(?:\.\d+)?$/.test(value)) return Date.parse(value)
  const numeric = Number(value)
  if (numeric >= 1e17) return numeric / 1e6
  if (numeric >= 1e14) return numeric / 1e3
  if (numeric >= 1e11) return numeric
  return numeric >= 1e9 ? numeric * 1_000 : Number.NaN
}

function reconciledTimestampCounts(evidence: DatasetEvidenceV2, csvText: string) {
  const expected = new Set(
    expectedEvidenceTimestamps({
      calendarId: evidence.calendar.id,
      sessionType: evidence.calendar.session_type,
      interval: evidence.interval,
      requestedStartInclusive: evidence.window.requested_start_inclusive,
      requestedEndInclusive: evidence.window.requested_end_inclusive,
    }),
  )
  const actual = csvTimestampSet(csvText)
  return {
    expected: expected.size,
    missing: [...expected].filter((timestamp) => !actual.has(timestamp)).length,
    extra: [...actual].filter((timestamp) => !expected.has(timestamp)).length,
  }
}

function reconciliationCountIssues(evidence: DatasetEvidenceV2, counts: ReturnType<typeof reconciledTimestampCounts>) {
  const issues: string[] = []
  if (evidence.timestamps.expected_count !== counts.expected) {
    issues.push(
      `timestamps.expected_count=${evidence.timestamps.expected_count} but calendar expects ${counts.expected}`,
    )
  }
  if (evidence.timestamps.missing_count !== counts.missing) {
    issues.push(
      `timestamps.missing_count=${evidence.timestamps.missing_count} but calendar reconciliation found ${counts.missing}`,
    )
  }
  if (evidence.timestamps.extra_count !== counts.extra) {
    issues.push(
      `timestamps.extra_count=${evidence.timestamps.extra_count} but calendar reconciliation found ${counts.extra}`,
    )
  }
  return issues
}

function calendarReconciliationIssues(evidence: DatasetEvidenceV2, csvText: string): string[] {
  if (!evidence.calendar || !evidence.window || !evidence.timestamps || !text(evidence.interval)) return []
  if (evidence.calendar.version !== DATASET_CALENDAR_VERSION)
    return [`calendar.version must be ${DATASET_CALENDAR_VERSION}`]
  try {
    return reconciliationCountIssues(evidence, reconciledTimestampCounts(evidence, csvText))
  } catch (error) {
    return [`calendar reconciliation failed: ${error instanceof Error ? error.message : String(error)}`]
  }
}

type ValidationInput = {
  manifest: unknown
  csvBytes: Uint8Array
  csvText: string
  csvFacts: EvidenceCsvFacts
}

function coreIdentityIssues(evidence: DatasetEvidenceV2): string[] {
  const issues: string[] = []
  if (evidence.schema !== DATASET_EVIDENCE_SCHEMA) issues.push(`schema must be ${DATASET_EVIDENCE_SCHEMA}`)
  if (evidence.version !== DATASET_EVIDENCE_VERSION) issues.push(`version must be ${DATASET_EVIDENCE_VERSION}`)
  if (!text(evidence.evidence_id)) issues.push("evidence_id is required")
  if (!text(evidence.interval)) issues.push("interval is required")
  return issues
}

function nestedIdentityIssues(evidence: DatasetEvidenceV2): string[] {
  const issues: string[] = []
  for (const [value, fields, prefix] of [
    [evidence.provider, ["id", "feed", "venue"], "provider"],
    [evidence.instrument, ["asset_class", "canonical_symbol", "provider_symbol"], "instrument"],
    [evidence.calendar, ["id", "version", "timezone", "session_type", "half_day_policy"], "calendar"],
    [
      evidence.window,
      ["requested_start_inclusive", "requested_end_inclusive", "actual_start_inclusive", "actual_end_inclusive"],
      "window",
    ],
  ] as Array<[Record<string, unknown> | undefined, string[], string]>) {
    if (!value || typeof value !== "object") issues.push(`${prefix} is required`)
    else issues.push(...requiredTextIssues(value, fields, prefix))
  }
  return issues
}

function timezoneIssues(evidence: DatasetEvidenceV2): string[] {
  if (!evidence.calendar?.timezone) return []
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: evidence.calendar.timezone }).format(0)
    return []
  } catch {
    return ["calendar.timezone is invalid"]
  }
}

function identityIssues(evidence: DatasetEvidenceV2, manifest: Record<string, unknown>): string[] {
  return [
    ...coreIdentityIssues(evidence),
    ...nestedIdentityIssues(evidence),
    ...legacyMirrorIssues(manifest, evidence),
    ...timezoneIssues(evidence),
  ]
}

function timestampSchemaIssues(evidence: DatasetEvidenceV2): string[] {
  const issues: string[] = []
  const timestampCounts = ["expected_count", "actual_count", "missing_count", "extra_count"] as const
  if (!evidence.timestamps || typeof evidence.timestamps !== "object") return ["timestamps is required"]
  for (const field of timestampCounts) {
    if (!nonnegativeInteger(evidence.timestamps[field])) {
      issues.push(`timestamps.${field} must be a non-negative integer`)
    }
  }
  issues.push(...rangeIssues(evidence.timestamps.missing_ranges, "missing_ranges"))
  if (evidence.timestamps.extra_ranges !== undefined) {
    issues.push(...rangeIssues(evidence.timestamps.extra_ranges, "extra_ranges"))
  }
  return issues
}

function missingRangeCount(evidence: DatasetEvidenceV2): number {
  if (!Array.isArray(evidence.timestamps.missing_ranges)) return 0
  return evidence.timestamps.missing_ranges.reduce(
    (sum, range) => sum + (nonnegativeInteger(range?.count) ? range.count : 0),
    0,
  )
}

function timestampConsistencyIssues(evidence: DatasetEvidenceV2, facts: EvidenceCsvFacts): string[] {
  if (!evidence.timestamps || typeof evidence.timestamps !== "object") return []
  const issues: string[] = []
  if (missingRangeCount(evidence) !== evidence.timestamps.missing_count) {
    issues.push("missing range counts do not equal missing_count")
  }
  if (evidence.timestamps.actual_count !== facts.uniqueTimestamps) {
    issues.push(
      `timestamps.actual_count=${evidence.timestamps.actual_count} but CSV has ${facts.uniqueTimestamps} unique timestamps`,
    )
  }
  const reconciled =
    evidence.timestamps.expected_count - evidence.timestamps.missing_count + evidence.timestamps.extra_count
  if (reconciled !== evidence.timestamps.actual_count) issues.push("timestamp counts are arithmetically inconsistent")
  return issues
}

function timestampIssues(evidence: DatasetEvidenceV2, input: ValidationInput): string[] {
  return [
    ...timestampSchemaIssues(evidence),
    ...timestampConsistencyIssues(evidence, input.csvFacts),
    ...calendarReconciliationIssues(evidence, input.csvText),
  ]
}

function qualitySchemaIssues(evidence: DatasetEvidenceV2): string[] {
  const issues: string[] = []
  const qualityFields = [
    "duplicate_count",
    "ohlc_violation_count",
    "outlier_count",
    "zero_volume_count",
    "invalid_volume_count",
    "incomplete_final_bar_count",
  ] as const
  if (!evidence.quality || typeof evidence.quality !== "object") return ["quality is required"]
  for (const field of qualityFields) {
    if (!nonnegativeInteger(evidence.quality[field])) issues.push(`quality.${field} must be a non-negative integer`)
  }
  return issues
}

function qualityCsvIssues(evidence: DatasetEvidenceV2, facts: EvidenceCsvFacts): string[] {
  const issues: string[] = []
  if (evidence.quality?.duplicate_count !== facts.duplicates) issues.push("quality.duplicate_count does not match CSV")
  if (evidence.quality?.ohlc_violation_count !== facts.invalidOhlc)
    issues.push("quality.ohlc_violation_count does not match CSV")
  if (facts.invalidRows > 0) issues.push(`CSV has ${facts.invalidRows} invalid rows`)
  return issues
}

function qualityIssues(evidence: DatasetEvidenceV2, facts: EvidenceCsvFacts): string[] {
  return [...qualitySchemaIssues(evidence), ...qualityCsvIssues(evidence, facts)]
}

function priceBasisIssues(evidence: DatasetEvidenceV2): string[] {
  const issues: string[] = []
  if (!evidence.price_basis || typeof evidence.price_basis !== "object") issues.push("price_basis is required")
  else {
    issues.push(
      ...requiredTextIssues(
        evidence.price_basis as unknown as Record<string, unknown>,
        ["basis", "split_treatment", "dividend_treatment", "corporate_action_status"],
        "price_basis",
      ),
    )
    if (!Array.isArray(evidence.price_basis.events)) issues.push("price_basis.events must be an array")
  }
  return issues
}

type DeclaredHashes = { raw?: string; semantic?: string; processed?: string }

function declaredHashes(evidence: DatasetEvidenceV2): DeclaredHashes {
  return {
    raw: normalizedHash(evidence.hashes.raw_bytes_sha256),
    semantic: normalizedHash(evidence.hashes.normalized_semantic_sha256),
    processed: normalizedHash(evidence.hashes.processed_bytes_sha256),
  }
}

function hashShapeIssues(hashes: DeclaredHashes): string[] {
  const issues: string[] = []
  if (!hashes.raw) issues.push("hashes.raw_bytes_sha256 must be SHA-256")
  if (!hashes.semantic) issues.push("hashes.normalized_semantic_sha256 must be SHA-256")
  if (!hashes.processed) issues.push("hashes.processed_bytes_sha256 must be SHA-256")
  return issues
}

function hashContentIssues(hashes: DeclaredHashes, input: ValidationInput): string[] {
  const issues: string[] = []
  const bytesHash = crypto.createHash("sha256").update(input.csvBytes).digest("hex")
  if (hashes.raw && hashes.raw !== bytesHash) issues.push("raw bytes hash does not match CSV")
  if (hashes.processed && hashes.processed !== bytesHash) issues.push("processed bytes hash does not match CSV")
  if (hashes.semantic && hashes.semantic !== normalizedCsvSemanticHash(input.csvText)) {
    issues.push("normalized semantic hash does not match CSV")
  }
  return issues
}

function hashIssues(evidence: DatasetEvidenceV2, input: ValidationInput): string[] {
  if (!evidence.hashes || typeof evidence.hashes !== "object") return ["hashes is required"]
  const hashes = declaredHashes(evidence)
  const versions = evidence.hashes.transformation_versions
  const versionIssues =
    versions && Object.keys(versions).length > 0 ? [] : ["hashes.transformation_versions must not be empty"]
  return [...hashShapeIssues(hashes), ...hashContentIssues(hashes, input), ...versionIssues]
}

function qualificationIssues(evidence: DatasetEvidenceV2): string[] {
  const issues: string[] = []
  if (!evidence.qualification || typeof evidence.qualification !== "object") issues.push("qualification is required")
  else {
    if (!["strict_qualified", "research_only", "blocked"].includes(evidence.qualification.status)) {
      issues.push("qualification.status is invalid")
    }
    if (!Array.isArray(evidence.qualification.reason_codes)) issues.push("qualification.reason_codes must be an array")
  }
  return issues
}

function repairLineageIssues(evidence: DatasetEvidenceV2): string[] {
  const issues: string[] = []
  if (evidence.repair_lineage) {
    if (!text(evidence.repair_lineage.parent_evidence_id)) issues.push("repair_lineage.parent_evidence_id is required")
    if (
      !Array.isArray(evidence.repair_lineage.transformations) ||
      evidence.repair_lineage.transformations.length === 0
    ) {
      issues.push("repair_lineage.transformations must be a non-empty array")
    }
    if (evidence.repair_lineage.parent_evidence_id === evidence.evidence_id) {
      issues.push("repaired dataset must receive a new evidence_id")
    }
    if (!text(evidence.repair_lineage.actor)) issues.push("repair_lineage.actor is required")
    if (!text(evidence.repair_lineage.approval)) issues.push("repair_lineage.approval is required")
  }
  return issues
}

function structuralIssues(evidence: DatasetEvidenceV2, input: ValidationInput): string[] {
  return [
    ...identityIssues(evidence, input.manifest as Record<string, unknown>),
    ...timestampIssues(evidence, input),
    ...qualityIssues(evidence, input.csvFacts),
    ...priceBasisIssues(evidence),
    ...hashIssues(evidence, input),
    ...qualificationIssues(evidence),
    ...repairLineageIssues(evidence),
  ]
}

export function validateDatasetEvidenceV2(input: ValidationInput): string[] {
  if (!input.manifest || typeof input.manifest !== "object") return ["DatasetEvidenceV2 manifest must be an object"]
  const evidence = input.manifest as DatasetEvidenceV2
  const issues = structuralIssues(evidence, input)
  if (hasStrictSafetyShape(evidence)) issues.push(...qualificationSafetyIssues(evidence))
  return issues
}

export function evidenceQualification(manifest: {
  schema?: unknown
  version?: unknown
  qualification?: { status?: unknown }
}): DatasetQualification {
  if (manifest.schema !== DATASET_EVIDENCE_SCHEMA || manifest.version !== DATASET_EVIDENCE_VERSION) {
    return "research_only_legacy"
  }
  const status = manifest.qualification?.status
  return status === "strict_qualified" || status === "research_only" || status === "blocked" ? status : "blocked"
}
