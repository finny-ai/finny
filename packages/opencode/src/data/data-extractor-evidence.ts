import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import type { WorkspaceRequestContext } from "@/agent/finny-workspace-context"
import { readRequestSpec } from "@/agent/request-spec"
import { requestSpecContext } from "@/agent/finny-workspace-context"
import { normalizeInterval, normalizeSymbol, type RequestFacts } from "@/agent/request-identity"
import { STRICT_DATA_QUALITY_LABELS } from "./data-quality-vocab"
import type { DataProviderFailureLayer } from "./data-provider-capabilities"
import { emit } from "@/analytics/emit"
import {
  DATASET_EVIDENCE_SCHEMA,
  DATASET_EVIDENCE_VERSION,
  evidenceQualification,
  validateDatasetEvidenceV2,
  type DatasetEvidenceV2,
  type DatasetQualification,
} from "./dataset-evidence-v2"

const BLOCKED_INCOMPLETE = "BLOCKED: data_extractor returned incomplete evidence artifacts"

/** Fields every successful extraction digest must carry. */
export const REQUIRED_DIGEST_FIELDS = [
  "requested_algorithm_name",
  "workspace_slug",
  "requested_symbol",
  "actual_symbol",
  "requested_interval",
  "actual_interval",
  "requested_asset_class",
  "actual_asset_class",
  "requested_start",
  "requested_end",
  "actual_start",
  "actual_end",
  "artifact_paths",
  "run_id",
  "usable_for_parent",
] as const

/** Manifest sidecar fields that must agree with the digest / request context. */
export const REQUIRED_MANIFEST_IDENTITY_FIELDS = [
  "requested_symbol",
  "actual_symbol",
  "requested_interval",
  "actual_interval",
  "requested_asset_class",
  "actual_asset_class",
  "requested_algorithm_name",
  "requested_start",
  "requested_end",
  "actual_start",
  "actual_end",
  "output_path",
  "run_id",
] as const

const ESTIMATED_METRIC_PATTERNS = [
  /\bCAGR\b/i,
  /\bestimated\b/i,
  /\bapprox(?:imate)?\b/i,
  /\bguess(?:ed|ing)?\b/i,
  /\binferred\b/i,
]

export interface DataExtractorManifest {
  schema?: string
  version?: number
  evidence_id?: string
  provider?: DatasetEvidenceV2["provider"]
  instrument?: DatasetEvidenceV2["instrument"]
  calendar?: DatasetEvidenceV2["calendar"]
  window?: DatasetEvidenceV2["window"]
  timestamps?: DatasetEvidenceV2["timestamps"]
  quality?: DatasetEvidenceV2["quality"]
  price_basis?: DatasetEvidenceV2["price_basis"]
  hashes?: DatasetEvidenceV2["hashes"]
  repair_lineage?: DatasetEvidenceV2["repair_lineage"]
  qualification?: DatasetEvidenceV2["qualification"]
  schema_version?: number
  source?: string
  symbols?: string[]
  interval?: string
  requested_symbol?: string
  actual_symbol?: string
  requested_interval?: string
  actual_interval?: string
  requested_asset_class?: string
  actual_asset_class?: string
  requested_algorithm_name?: string
  requested_start?: string
  requested_end?: string
  actual_start?: string
  actual_end?: string
  output_path?: string
  rows?: number
  run_id?: string
  request_id?: string
  request_version?: number
  request_content_hash?: string
  coverage?: string
  coverage_note?: string
  usable_for_parent?: string | boolean
  usable_for_research?: string | boolean
  strict_backtest_eligible?: string | boolean
  // Optional, lenient enrichment (issue #81). Never gates identity or reuse:
  // candidate edge analysis the data agent derives from the saved rows.
  analysis_summary_path?: string
  analysis_regime?: string
  analysis_hypotheses?: string[] | string
}

export interface ValidateDataExtractorInput {
  text: string
  workspaceSlug: string | null
  context?: WorkspaceRequestContext
  facts?: RequestFacts
}

export interface ValidateDataExtractorResult {
  ok: boolean
  text: string
  issues: string[]
  failureLayer?: DataProviderFailureLayer
}

export interface ExistingDataExtractorEvidenceResult {
  found: boolean
  result?: ValidateDataExtractorResult
  dataset?: VerifiedDatasetRef
}

export interface VerifiedDatasetIdentity {
  readonly schemaVersion?: number
  readonly source?: string
  readonly runId: string
  readonly requestedAlgorithmName: string
  readonly requestedSymbol: string
  readonly actualSymbol: string
  readonly requestedInterval: string
  readonly actualInterval: string
  readonly requestedAssetClass: string
  readonly actualAssetClass: string
  readonly requestedStart: string
  readonly requestedEnd: string
  readonly actualStart: string
  readonly actualEnd: string
  readonly rows?: number
  readonly evidenceId?: string
  readonly evidenceVersion: number
  readonly qualification: DatasetQualification
  readonly repaired: boolean
}

const VERIFIED_DATASET_REF = Symbol("finny.verified-dataset-ref")

/**
 * Immutable-by-hash reference to the exact data_extractor artifacts that
 * satisfied the active session's evidence gate.
 *
 * Paths locate the source artifacts; SHA-256 values bind downstream consumers
 * to the bytes that were verified. Consumers must re-hash before use so a file
 * changed after this gate cannot silently become backtest input.
 */
export interface VerifiedDatasetRef {
  readonly [VERIFIED_DATASET_REF]: true
  readonly manifestPath: string
  readonly manifestSha256: string
  readonly csvPath: string
  readonly csvSha256: string
  readonly identity: VerifiedDatasetIdentity
}

export function isVerifiedDatasetRef(value: unknown): value is VerifiedDatasetRef {
  return typeof value === "object" && value !== null && (value as VerifiedDatasetRef)[VERIFIED_DATASET_REF] === true
}

export type RequireVerifiedEvidenceResult =
  | (ValidateDataExtractorResult & {
      ok: true
      workspaceSlug: string
      dataset: VerifiedDatasetRef
    })
  | (ValidateDataExtractorResult & {
      ok: false
      workspaceSlug?: string
      dataset?: never
    })

function fieldValue(text: string, name: string): string | undefined {
  const patterns = [
    new RegExp(`(?:^|\\n|\\s)${name}\\s*[:=]\\s*([^\\n,;]+)`, "i"),
    new RegExp(`\`${name}\`\\s*[:=]?\\s*([^\\n,;]+)`, "i"),
    new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`, "i"),
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m?.[1]) return m[1].trim().replace(/^["'`]|["'`]$/g, "")
  }
  return undefined
}

function digestFieldValue(text: string, name: string): string | undefined {
  const value = fieldValue(text, name)
  if (!value) return value
  // Child summaries sometimes append a human explanation to scalar identity
  // values (for example `BTC-USD (yfinance symbol)`). The manifest remains the
  // canonical machine-readable identity, so do not treat that prose as part of
  // the value used to locate it.
  if (name !== "artifact_paths") return value.replace(/\s+\([^\n()]*\)\s*$/, "").trim()
  return value
}

function parseArtifactPaths(text: string): string[] {
  const rawValues = [
    fieldValue(text, "artifact_paths"),
    fieldValue(text, "csv path"),
    fieldValue(text, "manifest path"),
    ...Array.from(text.matchAll(/(?:^|\n)\s*(?:CSV|Manifest)\s*:\s*([^\n]+?)(?=\s+\(|\n|$)/gi), (match) => match[1]),
    ...Array.from(
      text.matchAll(
        /(?:^|\n)\s*(?:CSV|Manifest)\s+(?:Path\s+)?([A-Za-z0-9_./-]+\.(?:csv|manifest\.json))(?:\s|\n|$)/gi,
      ),
      (match) => match[1],
    ),
    ...Array.from(text.matchAll(/"(?:csv|manifest)"\s*:\s*"([^"]+\.(?:csv|manifest\.json))"/gi), (match) => match[1]),
    ...Array.from(
      text.matchAll(/(?:^|\s)([A-Za-z0-9_./-]+\.(?:csv|manifest\.json))(?=\s|,|;|\)|$)/gi),
      (match) => match[1],
    ),
  ].filter((value): value is string => Boolean(value))
  if (rawValues.length === 0) return []
  return rawValues
    .join(",")
    .split(/[,;]/)
    .map((part) =>
      part
        .trim()
        .replace(/\s+\([^)]*\)\s*$/, "")
        .replace(/^["'`]|["'`]$/g, ""),
    )
    .filter((part) => part.endsWith(".csv") || part.endsWith(".manifest.json"))
    .filter((part, index, all) => all.indexOf(part) === index)
    .filter(Boolean)
}

function manifestPathFromArtifacts(artifacts: string[], dataRoot: string): string | undefined {
  const manifest = artifacts.find((p) => p.endsWith(".manifest.json"))
  if (manifest) return path.isAbsolute(manifest) ? manifest : path.join(dataRoot, manifest)
  const csv = artifacts.find((p) => p.endsWith(".csv"))
  if (csv) {
    const rel = csv.endsWith(".csv") ? csv.replace(/\.csv$/, ".manifest.json") : `${csv}.manifest.json`
    return path.isAbsolute(rel) ? rel : path.join(dataRoot, rel)
  }
  return undefined
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function csvPathFromManifest(manifest: DataExtractorManifest, dataRoot: string): string | undefined {
  if (!manifest.output_path) return undefined
  return path.isAbsolute(manifest.output_path) ? manifest.output_path : path.join(dataRoot, manifest.output_path)
}

function requiredManifestString(manifest: DataExtractorManifest, field: keyof DataExtractorManifest): string {
  const value = manifest[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`verified manifest missing ${String(field)}`)
  }
  return value
}

interface VerifiedDatasetSnapshot {
  manifestPath: string
  manifestBytes: Buffer
  manifest: DataExtractorManifest
  csvPath: string
  csvBytes: Buffer
  csvInspection: CsvInspection
}

async function readVerifiedDatasetSnapshot(input: {
  manifestFile: string
  dataRoot: string
}): Promise<VerifiedDatasetSnapshot> {
  const manifestPath = await fs.realpath(input.manifestFile)
  const manifestBytes = await fs.readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as DataExtractorManifest
  const csvFile = csvPathFromManifest(manifest, input.dataRoot)
  if (!csvFile) throw new Error("verified manifest missing output_path for CSV")

  const csvPath = await fs.realpath(csvFile)
  const csvBytes = await fs.readFile(csvPath)
  return {
    manifestPath,
    manifestBytes,
    manifest,
    csvPath,
    csvBytes,
    csvInspection: inspectCsvEvidenceText(csvBytes.toString("utf8"), manifest),
  }
}

function buildVerifiedDatasetRef(snapshot: VerifiedDatasetSnapshot): VerifiedDatasetRef {
  const manifest = snapshot.manifest
  const identity: VerifiedDatasetIdentity = Object.freeze({
    schemaVersion: manifest.schema_version,
    source: manifest.source,
    runId: requiredManifestString(manifest, "run_id"),
    requestedAlgorithmName: requiredManifestString(manifest, "requested_algorithm_name"),
    requestedSymbol: requiredManifestString(manifest, "requested_symbol"),
    actualSymbol: requiredManifestString(manifest, "actual_symbol"),
    requestedInterval: requiredManifestString(manifest, "requested_interval"),
    actualInterval: requiredManifestString(manifest, "actual_interval"),
    requestedAssetClass: requiredManifestString(manifest, "requested_asset_class"),
    actualAssetClass: requiredManifestString(manifest, "actual_asset_class"),
    requestedStart: requiredManifestString(manifest, "requested_start"),
    requestedEnd: requiredManifestString(manifest, "requested_end"),
    actualStart: requiredManifestString(manifest, "actual_start"),
    actualEnd: requiredManifestString(manifest, "actual_end"),
    rows: manifest.rows,
    evidenceId: manifest.evidence_id,
    evidenceVersion:
      manifest.schema === DATASET_EVIDENCE_SCHEMA && manifest.version === DATASET_EVIDENCE_VERSION
        ? DATASET_EVIDENCE_VERSION
        : 1,
    qualification: evidenceQualification(manifest),
    repaired: Boolean(manifest.repair_lineage),
  })
  return Object.freeze({
    [VERIFIED_DATASET_REF]: true as const,
    manifestPath: snapshot.manifestPath,
    manifestSha256: crypto.createHash("sha256").update(snapshot.manifestBytes).digest("hex"),
    csvPath: snapshot.csvPath,
    csvSha256: crypto.createHash("sha256").update(snapshot.csvBytes).digest("hex"),
    identity,
  })
}

async function findManifestCandidates(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth < 0) return
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(file, depth - 1)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".manifest.json")) found.push(file)
    }
  }
  await walk(root, 4)
  found.sort()
  return found
}

/**
 * Data workspaces also contain sidecar manifests owned by news, sentiment, and
 * SEC agents. Those files may repeat the request identity, but they are not
 * OHLCV dataset evidence and must never make market-data discovery ambiguous.
 *
 * V2 evidence identifies itself with the canonical schema. Legacy extractor
 * manifests predate that schema, so recognize them by the top-level requested
 * and actual market identity plus their run id. Keep output_path out of this
 * classifier because the validator intentionally hydrates that one field for
 * otherwise valid legacy manifests.
 */
function isMarketDataManifest(manifest: DataExtractorManifest): boolean {
  if (manifest.schema === DATASET_EVIDENCE_SCHEMA) return true
  return Boolean(
    manifest.run_id &&
      manifest.requested_symbol &&
      manifest.actual_symbol &&
      manifest.requested_interval &&
      manifest.actual_interval &&
      manifest.requested_asset_class &&
      manifest.actual_asset_class,
  )
}

function evidenceRequiredBlock(reason: string, workspaceSlug?: string): RequireVerifiedEvidenceResult {
  const context = workspaceSlug ? `workspace_slug: ${workspaceSlug}\n` : ""
  return {
    ok: false,
    workspaceSlug,
    text: [
      "BLOCKED: verified data_extractor evidence is required for strict qualification or promotion.",
      context.trimEnd(),
      `reason: ${reason}`,
      "Exploratory provider-fetched backtests may proceed without this evidence, but remain research-only and non-promotable.",
      "Before strict qualification, run data_extractor with concrete symbol, interval, asset class, start date, and end date and require strict_backtest_eligible: yes.",
      "No qualified or promotable result produced.",
    ]
      .filter(Boolean)
      .join("\n"),
    issues: [reason],
  }
}

async function countCsvDataRows(csvPath: string): Promise<number> {
  const text = await fs.readFile(csvPath, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length <= 1) return 0
  return lines.length - 1
}

const REQUIRED_CSV_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"] as const

function intervalMilliseconds(value?: string): number | undefined {
  const normalized = value ? normalizeInterval(value) : undefined
  const match = normalized?.match(/^(\d+)(m|h)$/)
  if (!match) return undefined
  const amount = Number(match[1])
  return amount * (match[2] === "h" ? 60 * 60_000 : 60_000)
}

function displayInterval(milliseconds: number): string {
  if (milliseconds % (60 * 60_000) === 0) return `${milliseconds / (60 * 60_000)}h`
  return `${milliseconds / 60_000}m`
}

function scaleEpochToMillis(numeric: number): number {
  if (!Number.isFinite(numeric)) return Number.NaN
  if (numeric >= 1e17) return numeric / 1e6 // nanoseconds
  if (numeric >= 1e14) return numeric / 1e3 // microseconds
  if (numeric >= 1e11) return numeric // milliseconds
  if (numeric >= 1e9) return numeric * 1_000 // seconds
  return Number.NaN
}

function parseCsvTimestamp(raw?: string): number {
  const value = raw?.trim()
  if (!value) return Number.NaN
  if (/^\d+(?:\.\d+)?$/.test(value)) return scaleEpochToMillis(Number(value))
  return Date.parse(value)
}

interface CsvInspection {
  rows: number
  uniqueTimestamps: number
  duplicates: number
  invalidRows: number
  invalidOhlc: number
  firstTimestamp?: string
  lastTimestamp?: string
  issues: string[]
}

type CsvColumnIndex = Record<(typeof REQUIRED_CSV_COLUMNS)[number], number>
type CsvTimestamp = { raw: string; millis: number }

interface CsvRowScan {
  timestamps: CsvTimestamp[]
  seen: Set<number>
  duplicates: number
  invalidRows: number
  invalidOhlc: number
}

function manifestBoundaryMatches(value: string, csvMillis: number): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(csvMillis).toISOString().slice(0, 10) === value
  }
  return parseCsvTimestamp(value) === csvMillis
}

function csvColumnIndex(header: string[]): CsvColumnIndex {
  return Object.fromEntries(REQUIRED_CSV_COLUMNS.map((column) => [column, header.indexOf(column)])) as CsvColumnIndex
}

function isInvalidCsvRow(raw: string | undefined, millis: number, numeric: number[]): boolean {
  return !raw || !Number.isFinite(millis) || numeric.some((value) => !Number.isFinite(value))
}

function hasInvalidOhlc(open: number, high: number, low: number, close: number): boolean {
  return high < low || high < Math.max(open, close) || low > Math.min(open, close)
}

function recordCsvRow(line: string, index: CsvColumnIndex, scan: CsvRowScan): void {
  const values = line.split(",")
  const raw = values[index.timestamp]?.trim()
  const millis = parseCsvTimestamp(raw)
  const numeric = [index.open, index.high, index.low, index.close, index.volume].map((position) =>
    Number(values[position]),
  )
  if (isInvalidCsvRow(raw, millis, numeric)) {
    scan.invalidRows += 1
    return
  }
  if (scan.seen.has(millis)) scan.duplicates += 1
  scan.seen.add(millis)
  scan.timestamps.push({ raw, millis })
  const [open, high, low, close] = numeric
  if (hasInvalidOhlc(open, high, low, close)) scan.invalidOhlc += 1
}

function csvScanIssues(rows: number, scan: CsvRowScan): string[] {
  const issues: string[] = []
  if (rows === 0) issues.push("CSV is header-only or empty")
  if (scan.invalidRows > 0) {
    issues.push(`CSV has ${scan.invalidRows} rows with invalid timestamp or numeric OHLCV values`)
  }
  if (scan.duplicates > 0) issues.push(`CSV has ${scan.duplicates} duplicate timestamps`)
  if (scan.invalidOhlc > 0) issues.push(`CSV has ${scan.invalidOhlc} invalid OHLC rows`)
  const ordered = scan.timestamps.every(
    (entry, position) => position === 0 || entry.millis > scan.timestamps[position - 1].millis,
  )
  if (!ordered && scan.duplicates === 0) issues.push("CSV timestamps are not strictly increasing")
  return issues
}

function csvCadenceIssue(manifest: DataExtractorManifest, timestamps: CsvTimestamp[]): string | undefined {
  const requestedMs = intervalMilliseconds(manifest.actual_interval ?? manifest.requested_interval)
  if (!requestedMs || timestamps.length <= 1) return undefined
  const positiveDeltas = timestamps
    .slice(1)
    .map((entry, index) => entry.millis - timestamps[index].millis)
    .filter((delta) => delta > 0)
  const observedMs = positiveDeltas.length > 0 ? Math.min(...positiveDeltas) : undefined
  if (!observedMs || observedMs >= requestedMs) return undefined
  const requested = normalizeInterval(manifest.requested_interval ?? manifest.actual_interval ?? "")
  return `CSV cadence mismatch: requested ${requested}, observed ${displayInterval(observedMs)}`
}

function csvBoundaryIssue(
  label: "actual_start" | "actual_end",
  value: string | undefined,
  timestamp: CsvTimestamp | undefined,
): string | undefined {
  if (!value || !timestamp || manifestBoundaryMatches(value, timestamp.millis)) return undefined
  const verb = label === "actual_start" ? "starts" : "ends"
  return `manifest ${label}=${value} but CSV ${verb} at ${timestamp.raw}`
}

function inspectCsvEvidenceText(text: string, manifest: DataExtractorManifest): CsvInspection {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0)
    return { rows: 0, uniqueTimestamps: 0, duplicates: 0, invalidRows: 0, invalidOhlc: 0, issues: ["CSV is empty"] }

  const header = lines[0].split(",").map((value) => value.trim().toLowerCase())
  const missingColumns = REQUIRED_CSV_COLUMNS.filter((column) => !header.includes(column))
  if (missingColumns.length > 0) {
    return {
      rows: Math.max(0, lines.length - 1),
      uniqueTimestamps: 0,
      duplicates: 0,
      invalidRows: Math.max(0, lines.length - 1),
      invalidOhlc: 0,
      issues: [`CSV missing required columns: ${missingColumns.join(", ")}`],
    }
  }

  const rows = lines.length - 1
  const index = csvColumnIndex(header)
  const scan: CsvRowScan = { timestamps: [], seen: new Set(), duplicates: 0, invalidRows: 0, invalidOhlc: 0 }
  for (const line of lines.slice(1)) recordCsvRow(line, index, scan)

  const issues = csvScanIssues(rows, scan)
  const cadenceIssue = csvCadenceIssue(manifest, scan.timestamps)
  if (cadenceIssue) issues.push(cadenceIssue)
  const first = scan.timestamps[0]
  const last = scan.timestamps.at(-1)
  issues.push(
    ...[
      csvBoundaryIssue("actual_start", manifest.actual_start, first),
      csvBoundaryIssue("actual_end", manifest.actual_end, last),
    ].filter((issue): issue is string => Boolean(issue)),
  )

  return {
    rows,
    uniqueTimestamps: scan.seen.size,
    duplicates: scan.duplicates,
    invalidRows: scan.invalidRows,
    invalidOhlc: scan.invalidOhlc,
    firstTimestamp: first?.raw,
    lastTimestamp: last?.raw,
    issues,
  }
}

async function inspectCsvEvidence(csvPath: string, manifest: DataExtractorManifest): Promise<CsvInspection> {
  return inspectCsvEvidenceText(await fs.readFile(csvPath, "utf8"), manifest)
}

function normalizeAssetClass(value?: string): string | undefined {
  if (!value) return undefined
  const s = value.trim().toLowerCase()
  if (s === "equity" || s === "equities" || s === "stock" || s === "stocks") return "equity"
  if (s === "crypto" || s === "cryptocurrency") return "crypto"
  return s
}

type MatchKind = "symbol" | "interval" | "asset" | "date"

// Requested boundary dates legitimately drift a few calendar days between the
// request context and the manifest, but only inward: a window ending "today"
// is clamped to the last completed session, and boundaries landing on weekends
// or market holidays shift to the nearest trading day. The evidence-side date
// must never be later than the request-side date — a later start is missing
// data and a later end is lookahead exposure. Symbol/interval/asset/name stay
// strict; the CSV coverage checks still validate the actual data window.
const REQUESTED_DATE_TOLERANCE_DAYS = 5

function requestedDatesMatch(evidenceValue: string, requestValue: string): boolean {
  const evidenceDay = isoDate(evidenceValue)
  const requestDay = isoDate(requestValue)
  if (!evidenceDay || !requestDay) return evidenceValue.trim().toLowerCase() === requestValue.trim().toLowerCase()
  const diff = Date.parse(`${requestDay}T00:00:00Z`) - Date.parse(`${evidenceDay}T00:00:00Z`)
  return diff >= 0 && diff <= REQUESTED_DATE_TOLERANCE_DAYS * 24 * 60 * 60 * 1000
}

function valuesMatch(a?: string, b?: string, kind?: MatchKind): boolean {
  if (!a || !b) return true
  if (kind === "symbol") return normalizeSymbol(a) === normalizeSymbol(b)
  if (kind === "interval") return normalizeInterval(a) === normalizeInterval(b)
  if (kind === "asset") return normalizeAssetClass(a) === normalizeAssetClass(b)
  if (kind === "date") return requestedDatesMatch(a, b)
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// Optional enrichment digest lines (issue #81). Stripped before the estimated-metric
// scan so an `analysis_*: not_returned` sentinel can't disable the fabricated-metric
// guard for the rest of the response.
const ANALYSIS_DIGEST_LINE = /^[ \t]*analysis_(?:summary_path|regime|hypotheses)\s*[:=].*$/gim

function hasEstimatedMetrics(text: string): string | undefined {
  const scanned = text.replace(ANALYSIS_DIGEST_LINE, "")
  if (/\bnot_returned\b/i.test(scanned)) return undefined
  for (const re of ESTIMATED_METRIC_PATTERNS) {
    if (re.test(scanned)) return `estimated metric language matched ${re.source}`
  }
  return undefined
}

function missingDigestFields(text: string): string[] {
  const missing: string[] = []
  for (const field of REQUIRED_DIGEST_FIELDS) {
    if (!fieldValue(text, field)) missing.push(field)
  }
  const usable = normalizeUsableForParent(fieldValue(text, "usable_for_parent"))
  if (usable && !/^(yes|no)\b/.test(usable)) missing.push("usable_for_parent (must be yes/no)")
  return missing
}

function manifestIdentityIssues(manifest: DataExtractorManifest, digest: Record<string, string | undefined>): string[] {
  const issues: string[] = []
  for (const key of REQUIRED_MANIFEST_IDENTITY_FIELDS) {
    const manifestValue = manifest[key as keyof DataExtractorManifest]
    if (isBlank(manifestValue)) issues.push(`manifest missing ${key}`)
  }
  for (const issue of manifestDigestMismatches(manifest, digest)) issues.push(issue)
  return issues
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ""
}

function normalizeUsableForParent(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "boolean") return value ? "yes" : "no"
  const trimmed = String(value).trim()
  if (!trimmed) return undefined
  if (/^true\b/i.test(trimmed)) return trimmed.replace(/^true\b/i, "yes")
  if (/^false\b/i.test(trimmed)) return trimmed.replace(/^false\b/i, "no")
  return trimmed.toLowerCase()
}

function manifestDigestMismatches(
  manifest: DataExtractorManifest,
  digest: Record<string, string | undefined>,
): string[] {
  const pairs: Array<[keyof DataExtractorManifest, string | undefined, MatchKind | undefined]> = [
    ["requested_symbol", digest.requested_symbol, "symbol"],
    ["actual_symbol", digest.actual_symbol, "symbol"],
    ["requested_interval", digest.requested_interval, "interval"],
    ["actual_interval", digest.actual_interval, "interval"],
    ["requested_asset_class", digest.requested_asset_class, "asset"],
    ["actual_asset_class", digest.actual_asset_class, "asset"],
    ["requested_algorithm_name", digest.requested_algorithm_name, undefined],
    ["requested_start", digest.requested_start, "date"],
    ["requested_end", digest.requested_end, "date"],
    ["actual_start", digest.actual_start, undefined],
    ["actual_end", digest.actual_end, undefined],
    ["request_id", digest.request_id, undefined],
    ["request_version", digest.request_version, undefined],
    ["request_content_hash", digest.request_content_hash, undefined],
  ]
  return pairs.flatMap(([key, digestValue, kind]) => {
    const manifestValue = manifest[key]
    const mismatch =
      digestValue && manifestValue !== undefined && !valuesMatch(String(manifestValue), digestValue, kind)
    return mismatch ? [`manifest ${String(key)} mismatch (manifest=${manifestValue}, digest=${digestValue})`] : []
  })
}

function effectiveDigestFromManifest(
  manifest: DataExtractorManifest,
  digest: Record<string, string | undefined>,
  workspaceSlug: string,
  artifacts: string[],
): Record<string, string | undefined> {
  const artifactPaths = artifacts.length > 0 ? artifacts.join(", ") : undefined
  return {
    ...digest,
    workspace_slug: digest.workspace_slug ?? workspaceSlug,
    requested_symbol: digest.requested_symbol ?? manifest.requested_symbol,
    actual_symbol: digest.actual_symbol ?? manifest.actual_symbol,
    requested_interval: digest.requested_interval ?? manifest.requested_interval,
    actual_interval: digest.actual_interval ?? manifest.actual_interval,
    requested_asset_class: digest.requested_asset_class ?? manifest.requested_asset_class,
    actual_asset_class: digest.actual_asset_class ?? manifest.actual_asset_class,
    requested_algorithm_name: digest.requested_algorithm_name ?? manifest.requested_algorithm_name,
    requested_start: digest.requested_start ?? manifest.requested_start,
    requested_end: digest.requested_end ?? manifest.requested_end,
    actual_start: digest.actual_start ?? manifest.actual_start,
    actual_end: digest.actual_end ?? manifest.actual_end,
    artifact_paths: artifactPaths ?? digest.artifact_paths,
    run_id: manifest.run_id ?? digest.run_id,
    request_id: digest.request_id ?? manifest.request_id,
    request_version:
      digest.request_version ?? (manifest.request_version === undefined ? undefined : String(manifest.request_version)),
    request_content_hash: digest.request_content_hash ?? manifest.request_content_hash,
    usable_for_parent: normalizeUsableForParent(
      digest.usable_for_parent ??
        manifest.usable_for_parent ??
        (["complete", "trading_day_complete"].includes(manifest.coverage?.toLowerCase() ?? "") &&
        manifest.rows &&
        manifest.rows > 0
          ? "yes"
          : undefined),
    ),
    usable_for_research: normalizeUsableForParent(
      digest.usable_for_research ??
        manifest.usable_for_research ??
        digest.usable_for_parent ??
        manifest.usable_for_parent,
    ),
    strict_backtest_eligible: normalizeUsableForParent(
      digest.strict_backtest_eligible ??
        manifest.strict_backtest_eligible ??
        (evidenceQualification(manifest) === "strict_qualified" ? "yes" : "no"),
    ),
  }
}

function isoDate(value?: string): string | undefined {
  const match = value?.match(/\d{4}-\d{2}-\d{2}/)
  return match?.[0]
}

function previousUtcDay(isoDay: string): string | undefined {
  const date = new Date(`${isoDay}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return undefined
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function isOpenCurrentCandlePartial(manifest: DataExtractorManifest, digest: Record<string, string | undefined>) {
  const requestedEnd = isoDate(digest.requested_end ?? manifest.requested_end)
  const actualEnd = isoDate(digest.actual_end ?? manifest.actual_end)
  if (!requestedEnd || !actualEnd) return false
  const today = new Date().toISOString().slice(0, 10)
  if (requestedEnd !== today) return false
  if (actualEnd !== requestedEnd && actualEnd !== previousUtcDay(requestedEnd)) return false
  const note = `${manifest.coverage ?? ""} ${manifest.coverage_note ?? ""}`.toLowerCase()
  return /partial/.test(note) && /(current|open|not closed|still open|not yet|unavailable)/.test(note)
}

function blocked(issues: string[], failureLayer: DataProviderFailureLayer = "schema"): ValidateDataExtractorResult {
  return {
    ok: false,
    text: `${BLOCKED_INCOMPLETE}: ${issues.join("; ")}\nfailure_layer: ${failureLayer}`,
    issues,
    failureLayer,
  }
}

type ManifestDigest = Record<string, string | undefined>

async function matchArtifactManifest(
  artifacts: string[],
  digest: ManifestDigest,
  dataRoot: string,
): Promise<{ manifestFile?: string; issues: string[] }> {
  const fromArtifacts =
    manifestPathFromArtifacts(artifacts, dataRoot) ??
    (digest.artifact_paths ? manifestPathFromArtifacts([digest.artifact_paths], dataRoot) : undefined)
  if (!fromArtifacts || !(await fileExists(fromArtifacts))) return { issues: [] }
  try {
    const manifest = JSON.parse(await fs.readFile(fromArtifacts, "utf8")) as DataExtractorManifest
    if (!isMarketDataManifest(manifest)) return { issues: [] }
    const issues = manifestDigestMismatches(manifest, digest)
    return issues.length === 0 ? { manifestFile: fromArtifacts, issues } : { issues }
  } catch {
    // Continue to identity-based workspace discovery.
    return { issues: [] }
  }
}

async function findIdentityMatchingManifests(dataRoot: string, digest: ManifestDigest): Promise<string[]> {
  const candidates = await findManifestCandidates(dataRoot)
  const matches: string[] = []
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await fs.readFile(candidate, "utf8")) as DataExtractorManifest
      if (!isMarketDataManifest(manifest)) continue
      if (manifestDigestMismatches(manifest, digest).length === 0) matches.push(candidate)
    } catch {
      // Unreadable candidates are reported only if no valid identity match exists.
    }
  }
  return matches
}

function manifestResolutionIssue(matchCount: number, artifactIssues: string[]): string {
  if (matchCount > 0) return `could not resolve a unique identity-matching manifest (${matchCount} candidates)`
  return artifactIssues.length > 0
    ? `artifact manifest identity mismatch: ${artifactIssues.join("; ")}`
    : "could not resolve manifest path from artifact_paths"
}

async function resolveManifestFile(input: {
  artifacts: string[]
  digest: ManifestDigest
  dataRoot: string
  issues: string[]
}): Promise<{ manifestFile?: string; artifacts: string[]; result?: ValidateDataExtractorResult }> {
  const artifact = await matchArtifactManifest(input.artifacts, input.digest, input.dataRoot)
  if (artifact.manifestFile) return { manifestFile: artifact.manifestFile, artifacts: input.artifacts }

  const matches = await findIdentityMatchingManifests(input.dataRoot, input.digest)
  if (matches.length === 1) return { manifestFile: matches[0], artifacts: input.artifacts }

  const csvBlocker = await headerOnlyCsvBlocker(input.artifacts, input.dataRoot)
  if (csvBlocker) return { artifacts: input.artifacts, result: csvBlocker }

  input.issues.push(manifestResolutionIssue(matches.length, artifact.issues))
  return { artifacts: input.artifacts, result: blocked(input.issues) }
}

async function headerOnlyCsvBlocker(
  artifacts: string[],
  dataRoot: string,
): Promise<ValidateDataExtractorResult | undefined> {
  const csvArtifact = artifacts.find((p) => p.endsWith(".csv"))
  if (!csvArtifact) return undefined
  const csvFile = path.isAbsolute(csvArtifact) ? csvArtifact : path.join(dataRoot, csvArtifact)
  try {
    if ((await countCsvDataRows(csvFile)) > 0) return undefined
  } catch {
    return undefined
  }
  return {
    ok: false,
    text: [
      "BLOCKED: data_extractor returned unusable CSV evidence — artifact has no data rows.",
      `artifact_paths: ${csvFile}`,
      "No performance metrics produced. Do not save, validate, or backtest from header-only data.",
    ].join("\n"),
    issues: ["CSV is header-only or empty"],
  }
}

async function readManifestFile(
  manifestFile: string,
  artifacts: string[],
  dataRoot: string,
  issues: string[],
): Promise<{ manifest?: DataExtractorManifest; result?: ValidateDataExtractorResult }> {
  try {
    return { manifest: JSON.parse(await fs.readFile(manifestFile, "utf8")) as DataExtractorManifest }
  } catch (err: any) {
    const csvBlocker = await headerOnlyCsvBlocker(artifacts, dataRoot)
    if (csvBlocker) return { result: csvBlocker }
    issues.push(`manifest unreadable at ${manifestFile}: ${err?.message ?? String(err)}`)
    return { result: blocked(issues) }
  }
}

function insideDataRoot(file: string, dataRoot: string) {
  const relative = path.relative(path.resolve(dataRoot), path.resolve(file))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * `output_path` identifies the CSV artifact and is owned by the runtime, not by
 * provider/model prose. Upgrade legacy hand-written manifests when the emitted
 * artifact pair identifies exactly one workspace-local CSV.
 */
async function hydrateRuntimeManifest(input: {
  manifest: DataExtractorManifest
  manifestFile: string
  artifacts: string[]
  dataRoot: string
  context?: WorkspaceRequestContext
}): Promise<{ manifest?: DataExtractorManifest; issue?: string }> {
  const runtimeLineage = {
    ...(input.manifest.request_id === undefined && input.context?.request_id
      ? { request_id: input.context.request_id }
      : {}),
    ...(input.manifest.request_version === undefined && input.context?.request_version !== undefined
      ? { request_version: input.context.request_version }
      : {}),
    ...(input.manifest.request_content_hash === undefined && input.context?.request_content_hash
      ? { request_content_hash: input.context.request_content_hash }
      : {}),
  }
  if (input.manifest.output_path) {
    const manifest = { ...input.manifest, ...runtimeLineage }
    if (Object.keys(runtimeLineage).length > 0) {
      await fs.writeFile(input.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    }
    return { manifest }
  }

  const sibling = input.manifestFile.replace(/\.manifest\.json$/i, ".csv")
  const candidates = [
    ...input.artifacts
      .filter((artifact) => artifact.toLowerCase().endsWith(".csv"))
      .map((artifact) => (path.isAbsolute(artifact) ? artifact : path.join(input.dataRoot, artifact))),
    sibling,
  ]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter((candidate) => insideDataRoot(candidate, input.dataRoot))

  const existing: string[] = []
  for (const candidate of candidates) {
    if (await fileExists(candidate)) existing.push(candidate)
  }
  if (existing.length !== 1) {
    return { issue: `manifest missing output_path and runtime resolved ${existing.length} CSV artifacts` }
  }

  const outputPath = path.relative(input.dataRoot, existing[0]).replaceAll(path.sep, "/")
  const manifest = { ...input.manifest, output_path: outputPath, ...runtimeLineage }
  await fs.writeFile(input.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return { manifest }
}

function digestContextIssues(digest: Record<string, string | undefined>, context?: WorkspaceRequestContext): string[] {
  const issues = [
    ...contextSymbolIssues(digest, context),
    contextMismatch(
      digest.requested_interval,
      context?.requested_interval,
      "requested_interval differs from runtime context",
      "interval",
    ),
    contextMismatch(
      digest.requested_asset_class,
      context?.requested_asset_class,
      "requested_asset_class differs from runtime context",
      "asset",
    ),
    contextMismatch(
      digest.requested_start,
      context?.requested_start,
      "requested_start differs from runtime context",
      "date",
    ),
    contextMismatch(digest.requested_end, context?.requested_end, "requested_end differs from runtime context", "date"),
  ].filter((issue): issue is string => Boolean(issue))
  if (context?.request_version !== undefined && context.request_id && digest.request_id !== context.request_id) {
    issues.push(
      `request_id differs from runtime context (artifact=${digest.request_id ?? "MISSING"}, expected=${context.request_id})`,
    )
  }
  if (context?.request_version !== undefined && digest.request_version !== String(context.request_version)) {
    issues.push(
      `request_version differs from runtime context (artifact=${digest.request_version ?? "MISSING"}, expected=${context.request_version})`,
    )
  }
  if (
    context?.request_version !== undefined &&
    context?.request_content_hash &&
    digest.request_content_hash !== context.request_content_hash
  ) {
    issues.push("request_content_hash differs from runtime context")
  }
  return issues
}

function contextMismatch(
  digestValue: string | undefined,
  contextValue: string | undefined,
  issue: string,
  kind?: MatchKind,
): string | undefined {
  return contextValue && digestValue && !valuesMatch(digestValue, contextValue, kind) ? issue : undefined
}

function contextSymbolIssues(digest: Record<string, string | undefined>, context?: WorkspaceRequestContext): string[] {
  const allowed = (
    context?.requested_symbols?.length
      ? context.requested_symbols
      : context?.requested_symbol
        ? [context.requested_symbol]
        : []
  )
    .map((symbol) => normalizeSymbol(symbol))
    .filter((symbol): symbol is string => Boolean(symbol))
  if (allowed.length === 0) return []

  const issues: string[] = []
  for (const [field, value] of [
    ["requested_symbol", digest.requested_symbol],
    ["actual_symbol", digest.actual_symbol],
  ] as const) {
    const normalized = normalizeSymbol(value)
    if (normalized && !allowed.includes(normalized)) {
      issues.push(
        `${field} differs from runtime context universe (digest=${value}, expected one of ${allowed.join(",")})`,
      )
    }
  }
  return issues
}

async function csvEvidenceIssues(manifest: DataExtractorManifest, dataRoot: string): Promise<string[]> {
  const csvFile = csvPathFromManifest(manifest, dataRoot)
  if (!csvFile) return ["manifest missing output_path for CSV"]
  try {
    const csvBytes = await fs.readFile(csvFile)
    const csvText = csvBytes.toString("utf8")
    const inspection = inspectCsvEvidenceText(csvText, manifest)
    return csvEvidenceIssuesFromSnapshot({ manifest, csvBytes, csvText, inspection })
  } catch (err: any) {
    return [`CSV unreadable at ${csvFile}: ${err?.message ?? String(err)}`]
  }
}

function csvEvidenceIssuesFromSnapshot(input: {
  manifest: DataExtractorManifest
  csvBytes: Uint8Array
  csvText: string
  inspection: CsvInspection
}): string[] {
  const issues = csvInspectionIssues(input.manifest, input.inspection)
  if (input.manifest.schema === DATASET_EVIDENCE_SCHEMA || input.manifest.version === DATASET_EVIDENCE_VERSION) {
    issues.push(
      ...validateDatasetEvidenceV2({
        manifest: input.manifest,
        csvBytes: input.csvBytes,
        csvText: input.csvText,
        csvFacts: input.inspection,
      }),
    )
  }
  return issues
}

function csvInspectionIssues(manifest: DataExtractorManifest, inspection: CsvInspection): string[] {
  const issues = [...inspection.issues]
  if (typeof manifest.rows === "number" && manifest.rows !== inspection.rows) {
    issues.push(`manifest rows=${manifest.rows} but CSV has ${inspection.rows} data rows`)
  }
  return issues
}

function canonicalArtifacts(manifestFile: string, manifest: DataExtractorManifest, dataRoot: string): string[] {
  const paths = [manifest.output_path, path.relative(dataRoot, manifestFile).replaceAll(path.sep, "/")].filter(
    (value): value is string => Boolean(value),
  )
  return paths.filter((value, index) => paths.indexOf(value) === index)
}

function normalizeHypotheses(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  // Lenient: a malformed manifest (null/object/number entries from a hand-written
  // or failed summary update) must never throw or gate validation — drop non-strings.
  const parts = (Array.isArray(value) ? value : [value])
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts.join(" | ") : undefined
}

function renderManifestBlock(manifest: DataExtractorManifest, digest: Record<string, string | undefined>): string {
  const values: Array<[string, string | number | undefined]> = [
    ["requested_algorithm_name", digest.requested_algorithm_name],
    ["workspace_slug", digest.workspace_slug],
    ["requested_symbol", digest.requested_symbol],
    ["actual_symbol", digest.actual_symbol],
    ["requested_interval", digest.requested_interval],
    ["actual_interval", digest.actual_interval],
    ["requested_asset_class", digest.requested_asset_class],
    ["actual_asset_class", digest.actual_asset_class],
    ["requested_start", digest.requested_start],
    ["requested_end", digest.requested_end],
    ["actual_start", digest.actual_start],
    ["actual_end", digest.actual_end],
    ["artifact_paths", digest.artifact_paths],
    ["output_path", manifest.output_path],
    ["run_id", digest.run_id],
    ["request_id", digest.request_id],
    ["request_version", digest.request_version],
    ["request_content_hash", digest.request_content_hash],
    ["source", manifest.source],
    ["evidence_id", manifest.evidence_id],
    ["evidence_version", manifest.version],
    ["qualification", evidenceQualification(manifest)],
    ["coverage", manifest.coverage],
    ["rows", manifest.rows],
    ["usable_for_parent", digest.usable_for_parent],
    ["usable_for_research", digest.usable_for_research],
    ["strict_backtest_eligible", digest.strict_backtest_eligible],
    // Lenient enrichment (issue #81): preserved, never validated as identity.
    ["analysis_regime", manifest.analysis_regime],
    ["analysis_hypotheses", normalizeHypotheses(manifest.analysis_hypotheses)],
    ["analysis_summary_path", manifest.analysis_summary_path],
  ]
  return [
    "<data-extractor-manifest>",
    ...values.flatMap(([key, value]) =>
      value === undefined || value === null || String(value).trim() === "" ? [] : [`${key}: ${value}`],
    ),
    "</data-extractor-manifest>",
  ].join("\n")
}

function usabilityBlocker(
  textUsable: string,
  effectiveDigest: Record<string, string | undefined>,
  toleratedOpenCandlePartial: boolean,
): ValidateDataExtractorResult | undefined {
  const effectiveUsable = normalizeUsableForParent(effectiveDigest.usable_for_parent)
  if (!textUsable.startsWith("no") && !effectiveUsable?.startsWith("no")) return undefined
  if (toleratedOpenCandlePartial) return undefined
  return {
    ok: false,
    text: `BLOCKED: data_extractor marked evidence unusable_for_parent — ${effectiveDigest.usable_for_parent}`,
    issues: ["usable_for_parent: no"],
  }
}

function emitQualificationTelemetry(manifest: DataExtractorManifest, issues: string[]): void {
  if (manifest.schema !== DATASET_EVIDENCE_SCHEMA || manifest.version !== DATASET_EVIDENCE_VERSION) return
  emit({
    eventType: "data_evidence.qualified",
    source: "data_extractor_evidence",
    payload: {
      provider: manifest.provider?.id,
      feed: manifest.provider?.feed,
      venue: manifest.provider?.venue,
      evidenceId: manifest.evidence_id,
      evidenceVersion: manifest.version,
      calendar: manifest.calendar?.id,
      calendarVersion: manifest.calendar?.version,
      requestedStart: manifest.window?.requested_start_inclusive,
      requestedEnd: manifest.window?.requested_end_inclusive,
      actualStart: manifest.window?.actual_start_inclusive,
      actualEnd: manifest.window?.actual_end_inclusive,
      expectedCount: manifest.timestamps?.expected_count,
      actualCount: manifest.timestamps?.actual_count,
      missingCount: manifest.timestamps?.missing_count,
      extraCount: manifest.timestamps?.extra_count,
      duplicateCount: manifest.quality?.duplicate_count,
      repaired: Boolean(manifest.repair_lineage),
      incompleteCount: manifest.quality?.incomplete_final_bar_count,
      priceBasis: manifest.price_basis?.basis,
      corporateActionStatus: manifest.price_basis?.corporate_action_status,
      qualification: issues.length === 0 ? manifest.qualification?.status : "blocked",
      reasonCodes: issues.length === 0 ? manifest.qualification?.reason_codes : issues,
      evidenceHash: manifest.hashes?.normalized_semantic_sha256,
    },
  })
}

/**
 * Validate a data_extractor subagent result against manifest artifacts on disk.
 * Returns BLOCKED text when evidence is incomplete or mismatched.
 */
type DigestPreamble =
  | { result: ValidateDataExtractorResult }
  | {
      text: string
      textUsable: string
      workspaceSlug: string
      dataRoot: string
      digest: Record<string, string | undefined>
      issues: string[]
    }

function rejectedPreamble(text: string): DigestPreamble | undefined {
  if (text && !text.startsWith("BLOCKED:")) return undefined
  const failureLayer: DataProviderFailureLayer = /coverage|window unavailable|provider limit/i.test(text)
    ? "coverage"
    : /provider|credential|entitlement|source unavailable/i.test(text)
      ? "provider"
      : /schema|manifest|digest/i.test(text)
        ? "schema"
        : "retrieval"
  return {
    result: {
      ok: false,
      text: `${text || BLOCKED_INCOMPLETE}\nfailure_layer: ${failureLayer}`,
      issues: [],
      failureLayer,
    },
  }
}

function digestFields(text: string): Record<string, string | undefined> {
  return Object.fromEntries(
    [...REQUIRED_DIGEST_FIELDS, "request_id", "request_version", "request_content_hash"].map((field) => [
      field,
      digestFieldValue(text, field),
    ]),
  )
}

function digestFieldsFromContext(
  context: WorkspaceRequestContext | undefined,
  workspaceSlug: string,
): Record<string, string | undefined> {
  return {
    requested_algorithm_name: context?.requested_algorithm_name ?? workspaceSlug,
    workspace_slug: workspaceSlug,
    requested_symbol: context?.requested_symbol,
    actual_symbol: undefined,
    requested_interval: context?.requested_interval,
    actual_interval: undefined,
    requested_asset_class: context?.requested_asset_class,
    actual_asset_class: undefined,
    requested_start: context?.requested_start,
    requested_end: context?.requested_end,
    actual_start: undefined,
    actual_end: undefined,
    artifact_paths: undefined,
    run_id: undefined,
    request_id: context?.request_id,
    request_version: context?.request_version === undefined ? undefined : String(context.request_version),
    request_content_hash: context?.request_content_hash,
    usable_for_parent: undefined,
  }
}

function workspaceMismatchIssue(digest: Record<string, string | undefined>, workspaceSlug: string): string | undefined {
  if (!digest.workspace_slug || digest.workspace_slug === workspaceSlug) return undefined
  return `workspace_slug mismatch (digest=${digest.workspace_slug}, expected=${workspaceSlug})`
}

function prepareDigestPreamble(input: ValidateDataExtractorInput): DigestPreamble {
  const text = input.text.trim()
  const rejected = rejectedPreamble(text)
  if (rejected) return rejected
  const issues = [hasEstimatedMetrics(text)].filter((issue): issue is string => Boolean(issue))
  const textUsable = normalizeUsableForParent(digestFieldValue(text, "usable_for_parent")) ?? ""
  if (!input.workspaceSlug) return { result: blocked([...issues, "no workspace slug bound"]) }

  const dataRoot = path.join(algoDir(input.workspaceSlug), "data")
  const digest = digestFields(text)
  const mismatch = workspaceMismatchIssue(digest, input.workspaceSlug)
  if (mismatch) issues.push(mismatch)

  return { text, textUsable, workspaceSlug: input.workspaceSlug, dataRoot, digest, issues }
}

async function validateLoadedEvidence(input: {
  manifest: DataExtractorManifest
  artifacts: string[]
  preamble: Exclude<DigestPreamble, { result: ValidateDataExtractorResult }>
  context?: WorkspaceRequestContext
  csvIssues?: string[]
}): Promise<ValidateDataExtractorResult> {
  const { manifest, artifacts, preamble } = input
  const { text, textUsable, workspaceSlug, dataRoot, digest, issues } = preamble
  issues.push(...manifestIdentityIssues(manifest, digest))
  if (input.context?.request_version !== undefined) {
    if (manifest.request_id !== input.context.request_id)
      issues.push("manifest request_id does not match runtime RequestSpec")
    if (manifest.request_version !== input.context.request_version) {
      issues.push("manifest request_version does not match runtime RequestSpec")
    }
    if (manifest.request_content_hash !== input.context.request_content_hash) {
      issues.push("manifest request_content_hash does not match runtime RequestSpec")
    }
  }
  const effectiveDigest = effectiveDigestFromManifest(manifest, digest, workspaceSlug, artifacts)
  const missingFields = REQUIRED_DIGEST_FIELDS.filter((field) => !effectiveDigest[field])
  const effectiveUsable = normalizeUsableForParent(effectiveDigest.usable_for_parent)
  if (missingFields.length > 0) issues.push(`digest/manifest missing fields: ${missingFields.join(", ")}`)
  if (effectiveUsable && !/^(yes|no)\b/.test(effectiveUsable)) issues.push("usable_for_parent must be yes/no")

  const unusable = usabilityBlocker(textUsable, effectiveDigest, isOpenCurrentCandlePartial(manifest, effectiveDigest))
  if (unusable) {
    emitQualificationTelemetry(manifest, unusable.issues)
    return unusable
  }
  issues.push(
    ...(input.csvIssues ?? (await csvEvidenceIssues(manifest, dataRoot))),
    ...digestContextIssues(digest, input.context),
  )
  emitQualificationTelemetry(manifest, issues)
  return issues.length > 0
    ? blocked(issues)
    : { ok: true, text: `${text}\n\n${renderManifestBlock(manifest, effectiveDigest)}`, issues: [] }
}

export async function validateDataExtractorTaskText(
  input: ValidateDataExtractorInput,
): Promise<ValidateDataExtractorResult> {
  const preamble = prepareDigestPreamble(input)
  if ("result" in preamble) return preamble.result
  const { text, dataRoot, digest, issues } = preamble

  const resolved = await resolveManifestFile({ artifacts: parseArtifactPaths(text), digest, dataRoot, issues })
  if (resolved.result) return resolved.result
  const manifestFile = resolved.manifestFile!

  const loaded = await readManifestFile(manifestFile, resolved.artifacts, dataRoot, issues)
  if (loaded.result) return loaded.result
  const hydrated = await hydrateRuntimeManifest({
    manifest: loaded.manifest!,
    manifestFile,
    artifacts: resolved.artifacts,
    dataRoot,
    context: input.context,
  })
  if (hydrated.issue) return blocked([...issues, hydrated.issue], "schema")
  const manifest = hydrated.manifest!
  const artifacts = canonicalArtifacts(manifestFile, manifest, dataRoot)
  return validateLoadedEvidence({ manifest, artifacts, preamble, context: input.context })
}

/**
 * Reuse already-written data_extractor artifacts for the active request.
 *
 * This is intentionally identity-gated: a previous extraction only satisfies the
 * mandatory data step when exactly one manifest in the bound workspace matches
 * the current request context and the CSV evidence still passes validation.
 */
export async function validateExistingDataExtractorEvidence(input: {
  workspaceSlug: string | null
  context?: WorkspaceRequestContext
  dataRoot?: string
  requestedProvider?: string
}): Promise<ExistingDataExtractorEvidenceResult> {
  if (!input.workspaceSlug) return { found: false }
  if (input.context?.requested_symbols && input.context.requested_symbols.length > 1) return { found: false }

  const workspaceSlug = input.workspaceSlug
  const dataRoot = input.dataRoot ?? path.join(algoDir(workspaceSlug), "data")
  const baseDigest = digestFieldsFromContext(input.context, workspaceSlug)
  // Require the manifest's actual_* identity to satisfy the request's
  // requested_* identity. Without this, a stale or mislabeled manifest (e.g.
  // requested_symbol: SPY with actual_symbol: QQQ, or a requested 15m file
  // containing 5m bars) would slip through because manifestDigestMismatches
  // treats undefined digest values as wildcards.
  const digest: ManifestDigest = {
    ...baseDigest,
    actual_symbol: baseDigest.requested_symbol,
    actual_interval: baseDigest.requested_interval,
    actual_asset_class: baseDigest.requested_asset_class,
  }
  const matches = await findIdentityMatchingManifests(dataRoot, digest)
  if (matches.length === 0) return { found: false }
  if (matches.length > 1) {
    return {
      found: true,
      result: blocked([`could not resolve a unique identity-matching manifest (${matches.length} candidates)`]),
    }
  }

  const manifestFile = matches[0]
  // Hydrate legacy manifests missing only runtime-owned output_path before
  // snapshot reuse, matching validateDataExtractorTaskText.
  try {
    const rawBytes = await fs.readFile(manifestFile, "utf8")
    const rawManifest = JSON.parse(rawBytes) as DataExtractorManifest
    const hydrated = await hydrateRuntimeManifest({
      manifest: rawManifest,
      manifestFile,
      artifacts: [],
      dataRoot,
      context: input.context,
    })
    if (hydrated.issue) {
      return { found: true, result: blocked([hydrated.issue], "schema") }
    }
  } catch (error: any) {
    return {
      found: true,
      result: blocked([`failed to load identity-matching manifest: ${error?.message ?? String(error)}`], "schema"),
    }
  }

  let snapshot: VerifiedDatasetSnapshot
  try {
    snapshot = await readVerifiedDatasetSnapshot({ manifestFile, dataRoot })
  } catch (error: any) {
    return {
      found: true,
      result: blocked([`failed to snapshot verified data artifacts: ${error?.message ?? String(error)}`]),
    }
  }

  const manifest = snapshot.manifest
  if (
    input.requestedProvider &&
    normalizeProviderID(manifest.source) !== normalizeProviderID(input.requestedProvider)
  ) {
    return {
      found: true,
      result: blocked([
        `existing evidence provider ${manifest.source ?? "unknown"} does not match explicitly requested provider ${input.requestedProvider}`,
      ]),
    }
  }
  const artifacts = canonicalArtifacts(manifestFile, manifest, dataRoot)
  const preamble = {
    text: [
      "Data extraction already completed for this request; reusing verified workspace artifacts instead of launching another data_extractor.",
      "This satisfies the mandatory data_extractor step for the current workspace.",
    ].join("\n"),
    textUsable: "",
    workspaceSlug,
    dataRoot,
    digest,
    issues: [],
  }

  const result = await validateLoadedEvidence({
    manifest,
    artifacts,
    preamble,
    context: input.context,
    csvIssues: csvEvidenceIssuesFromSnapshot({
      manifest,
      csvBytes: snapshot.csvBytes,
      csvText: snapshot.csvBytes.toString("utf8"),
      inspection: snapshot.csvInspection,
    }),
  })
  if (!result.ok) return { found: true, result }

  try {
    return {
      found: true,
      result,
      dataset: buildVerifiedDatasetRef(snapshot),
    }
  } catch (error: any) {
    return {
      found: true,
      result: blocked([`failed to bind verified data artifacts: ${error?.message ?? String(error)}`]),
    }
  }
}

function normalizeProviderID(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "")
}

// finny_algorithm_save consolidates the workspace data tree into the saved
// algorithm store and leaves a symlink at <workspace>/algorithms/<name>.
// Evidence verified for the save must keep satisfying later session gates
// (backtest, validate), so those linked stores are searched as fallback roots.
async function linkedAlgorithmDataRoots(workspaceSlug: string): Promise<string[]> {
  const linksDir = path.join(algoDir(workspaceSlug), "algorithms")
  try {
    const entries = await fs.readdir(linksDir)
    return entries.map((name) => path.join(linksDir, name, "data"))
  } catch {
    return []
  }
}

export async function requireVerifiedDataExtractorEvidenceForSession(
  sessionID: string,
): Promise<RequireVerifiedEvidenceResult> {
  const workspaceSlug = await getSessionWorkspace(sessionID)
  if (!workspaceSlug) return evidenceRequiredBlock("no session workspace is bound")

  const spec = await readRequestSpec({ requestID: sessionID })
  if (!spec) return evidenceRequiredBlock("runtime RequestSpec is missing", workspaceSlug)
  const context = requestSpecContext(spec)
  const roots: Array<string | undefined> = [undefined, ...(await linkedAlgorithmDataRoots(workspaceSlug))]
  let blockedText: string | undefined
  for (const dataRoot of roots) {
    const existing = await validateExistingDataExtractorEvidence({ workspaceSlug, context, dataRoot })
    if (existing.found && existing.result?.ok && existing.dataset) {
      return {
        ok: true,
        text: existing.result.text,
        issues: existing.result.issues,
        workspaceSlug,
        dataset: existing.dataset,
      }
    }
    if (existing.found && existing.result) blockedText ??= existing.result.text
  }

  if (blockedText) return evidenceRequiredBlock(blockedText, workspaceSlug)
  return evidenceRequiredBlock("no matching data_extractor manifest found in the session workspace", workspaceSlug)
}

export function strictQualityLabelsPresent(text: string): boolean {
  return STRICT_DATA_QUALITY_LABELS.some((label) => new RegExp(`\\b${label}\\b`, "i").test(text))
}
