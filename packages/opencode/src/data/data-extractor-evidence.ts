import fs from "fs/promises"
import path from "path"
import { algoDir } from "@finny-ai/core/algo"
import type { WorkspaceRequestContext } from "@/agent/finny-workspace-context"
import { normalizeInterval, normalizeSymbol, type RequestFacts } from "@/agent/request-identity"
import { STRICT_DATA_QUALITY_LABELS } from "./data-quality-vocab"

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
  coverage?: string
  coverage_note?: string
  usable_for_parent?: string
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
}

export interface ExistingDataExtractorEvidenceResult {
  found: boolean
  result?: ValidateDataExtractorResult
}

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
      text.matchAll(/(?:^|\n)\s*(?:CSV|Manifest)\s+(?:Path\s+)?([A-Za-z0-9_./-]+\.(?:csv|manifest\.json))(?:\s|\n|$)/gi),
      (match) => match[1],
    ),
    ...Array.from(
      text.matchAll(/"(?:csv|manifest)"\s*:\s*"([^"]+\.(?:csv|manifest\.json))"/gi),
      (match) => match[1],
    ),
    ...Array.from(text.matchAll(/(?:^|\s)([A-Za-z0-9_./-]+\.(?:csv|manifest\.json))(?=\s|,|;|\)|$)/gi), (match) => match[1]),
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

async function inspectCsvEvidence(
  csvPath: string,
  manifest: DataExtractorManifest,
): Promise<CsvInspection> {
  const text = await fs.readFile(csvPath, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { rows: 0, issues: ["CSV is empty"] }

  const header = lines[0].split(",").map((value) => value.trim().toLowerCase())
  const missingColumns = REQUIRED_CSV_COLUMNS.filter((column) => !header.includes(column))
  if (missingColumns.length > 0) {
    return { rows: Math.max(0, lines.length - 1), issues: [`CSV missing required columns: ${missingColumns.join(", ")}`] }
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
    firstTimestamp: first?.raw,
    lastTimestamp: last?.raw,
    issues,
  }
}

function normalizeAssetClass(value?: string): string | undefined {
  if (!value) return undefined
  const s = value.trim().toLowerCase()
  if (s === "equity" || s === "equities" || s === "stock" || s === "stocks") return "equity"
  if (s === "crypto" || s === "cryptocurrency") return "crypto"
  return s
}

function valuesMatch(a?: string, b?: string, kind?: "symbol" | "interval" | "asset"): boolean {
  if (!a || !b) return true
  if (kind === "symbol") return normalizeSymbol(a) === normalizeSymbol(b)
  if (kind === "interval") return normalizeInterval(a) === normalizeInterval(b)
  if (kind === "asset") return normalizeAssetClass(a) === normalizeAssetClass(b)
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function hasEstimatedMetrics(text: string): string | undefined {
  if (/\bnot_returned\b/i.test(text)) return undefined
  for (const re of ESTIMATED_METRIC_PATTERNS) {
    if (re.test(text)) return `estimated metric language matched ${re.source}`
  }
  return undefined
}

function missingDigestFields(text: string): string[] {
  const missing: string[] = []
  for (const field of REQUIRED_DIGEST_FIELDS) {
    if (!fieldValue(text, field)) missing.push(field)
  }
  const usable = fieldValue(text, "usable_for_parent")?.toLowerCase()
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

function manifestDigestMismatches(manifest: DataExtractorManifest, digest: Record<string, string | undefined>): string[] {
  const pairs: Array<[keyof DataExtractorManifest, string | undefined, "symbol" | "interval" | "asset" | undefined]> = [
    ["requested_symbol", digest.requested_symbol, "symbol"],
    ["actual_symbol", digest.actual_symbol, "symbol"],
    ["requested_interval", digest.requested_interval, "interval"],
    ["actual_interval", digest.actual_interval, "interval"],
    ["requested_asset_class", digest.requested_asset_class, "asset"],
    ["actual_asset_class", digest.actual_asset_class, "asset"],
    ["requested_algorithm_name", digest.requested_algorithm_name, undefined],
    ["requested_start", digest.requested_start, undefined],
    ["requested_end", digest.requested_end, undefined],
    ["actual_start", digest.actual_start, undefined],
    ["actual_end", digest.actual_end, undefined],
    ["run_id", digest.run_id, undefined],
  ]
  return pairs.flatMap(([key, digestValue, kind]) => {
    const manifestValue = manifest[key]
    const mismatch = digestValue && manifestValue !== undefined && !valuesMatch(String(manifestValue), digestValue, kind)
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
    run_id: digest.run_id ?? manifest.run_id,
    usable_for_parent:
      digest.usable_for_parent ??
      manifest.usable_for_parent ??
      (["complete", "trading_day_complete"].includes(manifest.coverage?.toLowerCase() ?? "") &&
      manifest.rows &&
      manifest.rows > 0
        ? "yes"
        : undefined),
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

function blocked(issues: string[]): ValidateDataExtractorResult {
  return { ok: false, text: `${BLOCKED_INCOMPLETE}: ${issues.join("; ")}`, issues }
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

async function headerOnlyCsvBlocker(artifacts: string[], dataRoot: string): Promise<ValidateDataExtractorResult | undefined> {
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

function digestContextIssues(
  digest: Record<string, string | undefined>,
  context?: WorkspaceRequestContext,
): string[] {
  return [
    contextMismatch(digest.requested_start, context?.requested_start, "requested_start differs from runtime context"),
    contextMismatch(digest.requested_end, context?.requested_end, "requested_end differs from runtime context"),
  ].filter((issue): issue is string => Boolean(issue))
}

function contextMismatch(digestValue: string | undefined, contextValue: string | undefined, issue: string): string | undefined {
  return contextValue && digestValue && digestValue !== contextValue ? issue : undefined
}

async function csvEvidenceIssues(manifest: DataExtractorManifest, dataRoot: string): Promise<string[]> {
  const csvFile = csvPathFromManifest(manifest, dataRoot)
  if (!csvFile) return ["manifest missing output_path for CSV"]
  try {
    const inspection = await inspectCsvEvidence(csvFile, manifest)
    const issues = [...inspection.issues]
    if (typeof manifest.rows === "number" && manifest.rows !== inspection.rows) {
      issues.push(`manifest rows=${manifest.rows} but CSV has ${inspection.rows} data rows`)
    }
    return issues
  } catch (err: any) {
    return [`CSV unreadable at ${csvFile}: ${err?.message ?? String(err)}`]
  }
}

function canonicalArtifacts(manifestFile: string, manifest: DataExtractorManifest, dataRoot: string): string[] {
  const paths = [
    manifest.output_path,
    path.relative(dataRoot, manifestFile).replaceAll(path.sep, "/"),
  ].filter((value): value is string => Boolean(value))
  return paths.filter((value, index) => paths.indexOf(value) === index)
}

function renderManifestBlock(
  manifest: DataExtractorManifest,
  digest: Record<string, string | undefined>,
): string {
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
    ["run_id", digest.run_id],
    ["source", manifest.source],
    ["coverage", manifest.coverage],
    ["rows", manifest.rows],
    ["usable_for_parent", digest.usable_for_parent],
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
  const effectiveUsable = effectiveDigest.usable_for_parent?.toLowerCase()
  if (!textUsable.startsWith("no") && !effectiveUsable?.startsWith("no")) return undefined
  if (toleratedOpenCandlePartial) return undefined
  return {
    ok: false,
    text: `BLOCKED: data_extractor marked evidence unusable_for_parent — ${effectiveDigest.usable_for_parent}`,
    issues: ["usable_for_parent: no"],
  }
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
  return { result: { ok: false, text: text || BLOCKED_INCOMPLETE, issues: [] } }
}

function digestFields(text: string): Record<string, string | undefined> {
  return Object.fromEntries(REQUIRED_DIGEST_FIELDS.map((field) => [field, digestFieldValue(text, field)]))
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
  const textUsable = digestFieldValue(text, "usable_for_parent")?.toLowerCase() ?? ""
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
}): Promise<ValidateDataExtractorResult> {
  const { manifest, artifacts, preamble } = input
  const { text, textUsable, workspaceSlug, dataRoot, digest, issues } = preamble
  issues.push(...manifestIdentityIssues(manifest, digest))
  const effectiveDigest = effectiveDigestFromManifest(manifest, digest, workspaceSlug, artifacts)
  const missingFields = REQUIRED_DIGEST_FIELDS.filter((field) => !effectiveDigest[field])
  const effectiveUsable = effectiveDigest.usable_for_parent?.toLowerCase()
  if (missingFields.length > 0) issues.push(`digest/manifest missing fields: ${missingFields.join(", ")}`)
  if (effectiveUsable && !/^(yes|no)\b/.test(effectiveUsable)) issues.push("usable_for_parent must be yes/no")

  const unusable = usabilityBlocker(textUsable, effectiveDigest, isOpenCurrentCandlePartial(manifest, effectiveDigest))
  if (unusable) return unusable
  issues.push(...(await csvEvidenceIssues(manifest, dataRoot)), ...digestContextIssues(digest, input.context))
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
  const manifest = loaded.manifest!
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
}): Promise<ExistingDataExtractorEvidenceResult> {
  if (!input.workspaceSlug) {
    return { found: true, result: blocked(["no workspace slug bound"]) }
  }

  const workspaceSlug = input.workspaceSlug
  const dataRoot = path.join(algoDir(workspaceSlug), "data")
  const digest = digestFieldsFromContext(input.context, workspaceSlug)
  const matches = await findIdentityMatchingManifests(dataRoot, digest)
  if (matches.length === 0) return { found: false }
  if (matches.length > 1) {
    return {
      found: true,
      result: blocked([`could not resolve a unique identity-matching manifest (${matches.length} candidates)`]),
    }
  }

  const manifestFile = matches[0]
  const loaded = await readManifestFile(manifestFile, [], dataRoot, [])
  if (loaded.result) return { found: true, result: loaded.result }

  const manifest = loaded.manifest!
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

  return {
    found: true,
    result: await validateLoadedEvidence({ manifest, artifacts, preamble, context: input.context }),
  }
}

export function strictQualityLabelsPresent(text: string): boolean {
  return STRICT_DATA_QUALITY_LABELS.some((label) => new RegExp(`\\b${label}\\b`, "i").test(text))
}
