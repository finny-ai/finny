import fs from "node:fs/promises"
import path from "node:path"
import {
  verifyStrictRunDir,
  type RunManifestV1 as StrictRunManifestV1,
  type StrictRunV1,
} from "../../src/backtest/run-integrity"
import { addContentAddressedArtifact, type BundleWriter } from "./artifacts"
import { artifactCaptureDecision, RUNTIME_DIRECTORIES } from "./artifact-policy"

export type HarnessIntegrityIssue = {
  kind: "secret_integrity" | "artifact_integrity"
  message: string
}

export type HarnessArtifactIndexEntry = {
  source: string
  object: string
  sha256: string
  size: number
}

export type ArtifactCaptureLimits = {
  maxFiles: number
  maxBytes: number
  maxFileBytes: number
}

export const DEFAULT_ARTIFACT_CAPTURE_LIMITS: ArtifactCaptureLimits = {
  maxFiles: 256,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
}

export type { ArtifactCaptureDecision } from "./artifact-policy"
export { artifactCaptureDecision } from "./artifact-policy"

type WalkResult = {
  files: string[]
  prunedRuntimeDirectories: number
}

async function filesUnder(root: string): Promise<WalkResult> {
  const files: string[] = []
  let prunedRuntimeDirectories = 0
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (RUNTIME_DIRECTORIES.has(entry.name)) {
          prunedRuntimeDirectories++
          continue
        }
        await visit(absolute)
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute))
      }
    }
  }
  await visit(root)
  return { files: files.sort(), prunedRuntimeDirectories }
}

type ExclusionSummary = Record<string, { entries: number; bytes: number }>

function exclude(summary: ExclusionSummary, reason: string, bytes = 0): void {
  const current = summary[reason] ?? { entries: 0, bytes: 0 }
  current.entries++
  current.bytes += bytes
  summary[reason] = current
}

function overCaptureLimit(input: {
  size: number
  includedBytes: number
  indexSize: number
  limits: ArtifactCaptureLimits
}): boolean {
  if (input.size > input.limits.maxFileBytes) return true
  if (input.indexSize >= input.limits.maxFiles) return true
  return input.includedBytes + input.size > input.limits.maxBytes
}

function noteCaptureLimit(input: {
  issues: HarnessIntegrityIssue[]
  excluded: ExclusionSummary
  size: number
  limits: ArtifactCaptureLimits
  reported: boolean
}): boolean {
  exclude(input.excluded, "capture_limit", input.size)
  if (input.reported) return true
  input.issues.push({
    kind: "artifact_integrity",
    message: `Finny artifact capture exceeded limits (${input.limits.maxFiles} files, ${input.limits.maxBytes} bytes total, ${input.limits.maxFileBytes} bytes per file)`,
  })
  return true
}

async function captureOneArtifact(input: {
  writer: BundleWriter
  finnyHome: string
  relative: string
  secretValues: string[]
  limits: ArtifactCaptureLimits
  index: HarnessArtifactIndexEntry[]
  issues: HarnessIntegrityIssue[]
  excluded: ExclusionSummary
  includedBytes: number
  capReported: boolean
}): Promise<{ includedBytes: number; capReported: boolean }> {
  const source = path.join(input.finnyHome, input.relative)
  const stat = await fs.stat(source)
  const decision = artifactCaptureDecision({ relative: input.relative })
  if (!decision.include) {
    exclude(input.excluded, decision.reason, stat.size)
    return { includedBytes: input.includedBytes, capReported: input.capReported }
  }
  if (
    overCaptureLimit({
      size: stat.size,
      includedBytes: input.includedBytes,
      indexSize: input.index.length,
      limits: input.limits,
    })
  ) {
    const capReported = noteCaptureLimit({
      issues: input.issues,
      excluded: input.excluded,
      size: stat.size,
      limits: input.limits,
      reported: input.capReported,
    })
    return { includedBytes: input.includedBytes, capReported }
  }
  const bytes = await fs.readFile(source)
  const leaked = input.secretValues.find((secret) => bytes.includes(Buffer.from(secret)))
  if (leaked) {
    input.issues.push({
      kind: "secret_integrity",
      message: `secret value detected in Finny artifact ${input.relative}`,
    })
    return { includedBytes: input.includedBytes, capReported: input.capReported }
  }
  const artifact = await addContentAddressedArtifact({
    writer: input.writer,
    source,
    kind: "finny-artifact",
  })
  input.index.push({
    source: input.relative,
    object: artifact.path,
    sha256: artifact.sha256,
    size: artifact.size,
  })
  return { includedBytes: input.includedBytes + artifact.size, capReported: input.capReported }
}

/** Copy only bounded, reviewable Finny evidence before interpreting its schema. */
export async function collectFinnyArtifacts(input: {
  writer: BundleWriter
  finnyHome: string
  secretValues: string[]
  limits?: Partial<ArtifactCaptureLimits>
}): Promise<{
  index: HarnessArtifactIndexEntry[]
  issues: HarnessIntegrityIssue[]
  capture: {
    includedFiles: number
    includedBytes: number
    limits: ArtifactCaptureLimits
    excluded: ExclusionSummary
  }
}> {
  const limits = { ...DEFAULT_ARTIFACT_CAPTURE_LIMITS, ...input.limits }
  const index: HarnessArtifactIndexEntry[] = []
  const issues: HarnessIntegrityIssue[] = []
  const excluded: ExclusionSummary = {}
  const walked = await filesUnder(input.finnyHome)
  if (walked.prunedRuntimeDirectories > 0) {
    excluded.runtime_directory = { entries: walked.prunedRuntimeDirectories, bytes: 0 }
  }
  let includedBytes = 0
  let capReported = false
  for (const relative of walked.files) {
    const next = await captureOneArtifact({
      writer: input.writer,
      finnyHome: input.finnyHome,
      relative,
      secretValues: input.secretValues,
      limits,
      index,
      issues,
      excluded,
      includedBytes,
      capReported,
    })
    includedBytes = next.includedBytes
    capReported = next.capReported
  }
  return {
    index,
    issues,
    capture: { includedFiles: index.length, includedBytes, limits, excluded },
  }
}

export type VerifiedHarnessRun = {
  dir: string
  artifactPath: string
  run: StrictRunV1
  manifest: StrictRunManifestV1
  assetSpec: Record<string, unknown>
  dataManifest: Record<string, unknown>
  strategyResult: Record<string, unknown>
}

async function readObject(file: string): Promise<Record<string, unknown>> {
  const value = JSON.parse(await fs.readFile(file, "utf8"))
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}


function unifiedVerdictOf(parsed: Record<string, unknown>): string | undefined {
  if (typeof parsed.unifiedVerdict === "string") return parsed.unifiedVerdict
  const recommendation = parsed.recommendation as Record<string, unknown> | undefined
  if (typeof recommendation?.verdict === "string") return recommendation.verdict
  if (typeof parsed.verdict === "string") return parsed.verdict
}

async function inspectOneStrictRun(input: {
  finnyHome: string
  relative: string
}): Promise<{
  results: Array<Record<string, unknown>>
  runs: VerifiedHarnessRun[]
  issues: HarnessIntegrityIssue[]
}> {
  const results: Array<Record<string, unknown>> = []
  const runs: VerifiedHarnessRun[] = []
  const issues: HarnessIntegrityIssue[] = []
  const file = path.join(input.finnyHome, input.relative)
  const dir = path.dirname(file)
  try {
    const verification = await verifyStrictRunDir(dir)
    if (!verification.ok || !verification.run || !verification.manifest) {
      for (const error of verification.errors) {
        issues.push({ kind: "artifact_integrity", message: `${input.relative}: ${error}` })
      }
      return { results, runs, issues }
    }
    const parsed = await readObject(file)
    const unifiedVerdict = unifiedVerdictOf(parsed)
    const strategyResult = {
      artifactPath: input.relative,
      ...parsed,
      ...(unifiedVerdict ? { unifiedVerdict } : {}),
    }
    results.push(strategyResult)
    runs.push({
      dir,
      artifactPath: input.relative,
      run: verification.run,
      manifest: verification.manifest,
      assetSpec: await readObject(path.join(dir, "asset_spec.json")),
      dataManifest: await readObject(path.join(dir, "data_extractor.manifest.json")),
      strategyResult,
    })
  } catch (error) {
    issues.push({
      kind: "artifact_integrity",
      message: `${input.relative}: strict verifier failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
  return { results, runs, issues }
}

/** Invalid JSON remains bundled, but only product-verifier-valid runs become results. */
export async function inspectStrategyResults(finnyHome: string): Promise<{
  results: Array<Record<string, unknown>>
  runs: VerifiedHarnessRun[]
  issues: HarnessIntegrityIssue[]
}> {
  const results: Array<Record<string, unknown>> = []
  const runs: VerifiedHarnessRun[] = []
  const issues: HarnessIntegrityIssue[] = []
  const walked = await filesUnder(finnyHome)
  for (const relative of walked.files) {
    if (!relative.endsWith(`${path.sep}run.json`) && relative !== "run.json") continue
    const inspected = await inspectOneStrictRun({ finnyHome, relative })
    results.push(...inspected.results)
    runs.push(...inspected.runs)
    issues.push(...inspected.issues)
  }
  return { results, runs, issues }
}

export type ObservedSavedCandidate = {
  name?: string
  algorithmId?: string
  version?: number
}

export type ObservedBacktestRun = {
  algorithmName?: string
  runId?: string
  artifactDir?: string
}

type ScenarioIdentity = {
  symbols: string[]
  assetClass: string
  interval: string
  startDate: string
  endDate: string
}

function canonicalAssetClass(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
  return normalized === "equities" ? "equity" : normalized
}

function canonicalInterval(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
  return ["5min", "5mins", "5minute", "5minutes"].includes(normalized) ? "5m" : normalized
}

function canonicalDate(value: unknown): string {
  const normalized = String(value ?? "").trim()
  return normalized.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? normalized
}

function expectedSymbols(scenario: ScenarioIdentity): string[] {
  return [...new Set(scenario.symbols.map((symbol) => symbol.trim().toUpperCase()))].sort()
}

function dateWindowMismatch(run: VerifiedHarnessRun, scenario: ScenarioIdentity): boolean {
  const identity = run.run.identity
  if (canonicalDate(identity.dateWindow.start) !== canonicalDate(scenario.startDate)) return true
  if (canonicalDate(identity.dateWindow.end) !== canonicalDate(scenario.endDate)) return true
  return canonicalInterval(identity.dateWindow.interval) !== canonicalInterval(scenario.interval)
}

function assetIdentityMismatch(run: VerifiedHarnessRun, scenario: ScenarioIdentity, symbols: string[]): string | undefined {
  const assetSymbol = String(run.assetSpec.symbol ?? "")
    .trim()
    .toUpperCase()
  if (!assetSymbol) return `strict run ${run.run.runId} asset symbol does not match scenario`
  if (symbols.length !== 1) return `strict run ${run.run.runId} asset symbol does not match scenario`
  if (assetSymbol !== symbols[0]) return `strict run ${run.run.runId} asset symbol does not match scenario`
  const assetClass = canonicalAssetClass(run.assetSpec.assetClass ?? run.assetSpec.asset_class)
  if (assetClass !== canonicalAssetClass(scenario.assetClass)) {
    return `strict run ${run.run.runId} asset class does not match scenario`
  }
}

function dataManifestSymbols(run: VerifiedHarnessRun): string[] {
  if (Array.isArray(run.dataManifest.symbols)) {
    return run.dataManifest.symbols.map((symbol) => String(symbol).trim().toUpperCase()).sort()
  }
  return [
    String(run.dataManifest.requested_symbol ?? "")
      .trim()
      .toUpperCase(),
  ].filter(Boolean)
}

function dataSymbolMismatch(run: VerifiedHarnessRun, symbols: string[]): string | undefined {
  const dataSymbols = dataManifestSymbols(run)
  if (dataSymbols.length !== symbols.length || dataSymbols.some((symbol, index) => symbol !== symbols[index])) {
    return `strict run ${run.run.runId} data manifest symbols do not match scenario`
  }
  const requestedSymbol = String(run.dataManifest.requested_symbol ?? "")
    .trim()
    .toUpperCase()
  const actualSymbol = String(run.dataManifest.actual_symbol ?? requestedSymbol)
    .trim()
    .toUpperCase()
  if (!symbols.includes(requestedSymbol) || !symbols.includes(actualSymbol)) {
    return `strict run ${run.run.runId} data manifest symbol binding does not match scenario`
  }
}

function intervalMismatch(run: VerifiedHarnessRun, interval: string): boolean {
  if (canonicalInterval(run.dataManifest.requested_interval ?? run.dataManifest.interval) !== interval) return true
  return canonicalInterval(run.dataManifest.actual_interval ?? run.dataManifest.requested_interval) !== interval
}

function assetClassMismatch(run: VerifiedHarnessRun, assetClass: string): boolean {
  if (canonicalAssetClass(run.dataManifest.requested_asset_class) !== assetClass) return true
  return canonicalAssetClass(run.dataManifest.actual_asset_class ?? run.dataManifest.requested_asset_class) !== assetClass
}

function windowMismatch(run: VerifiedHarnessRun, scenario: ScenarioIdentity): boolean {
  if (canonicalDate(run.dataManifest.requested_start) !== canonicalDate(scenario.startDate)) return true
  if (canonicalDate(run.dataManifest.requested_end) !== canonicalDate(scenario.endDate)) return true
  if (canonicalDate(run.dataManifest.actual_start) !== canonicalDate(scenario.startDate)) return true
  return canonicalDate(run.dataManifest.actual_end) !== canonicalDate(scenario.endDate)
}

function dataRequestMismatch(run: VerifiedHarnessRun, scenario: ScenarioIdentity): boolean {
  const interval = canonicalInterval(scenario.interval)
  const assetClass = canonicalAssetClass(scenario.assetClass)
  if (intervalMismatch(run, interval)) return true
  if (assetClassMismatch(run, assetClass)) return true
  if (windowMismatch(run, scenario)) return true
  return run.dataManifest.usable_for_parent !== "yes"
}

function scenarioRunIssues(run: VerifiedHarnessRun, scenario: ScenarioIdentity): HarnessIntegrityIssue[] {
  const issues: HarnessIntegrityIssue[] = []
  const add = (message: string) => issues.push({ kind: "artifact_integrity", message })
  if (dateWindowMismatch(run, scenario)) add(`strict run ${run.run.runId} date window does not match scenario`)
  const symbols = expectedSymbols(scenario)
  const assetIssue = assetIdentityMismatch(run, scenario, symbols)
  if (assetIssue) add(assetIssue)
  const symbolIssue = dataSymbolMismatch(run, symbols)
  if (symbolIssue) add(symbolIssue)
  if (dataRequestMismatch(run, scenario)) {
    add(`strict run ${run.run.runId} data manifest request does not match scenario`)
  }
  if (run.dataManifest.csv_sha256 !== run.run.identity.rawDataHash) {
    add(`strict run ${run.run.runId} data manifest CSV hash does not match run identity`)
  }
  return issues
}

function outsideFinnyHome(finnyHome: string, artifactDir: string): boolean {
  const home = path.resolve(finnyHome)
  const reported = path.resolve(artifactDir)
  if (reported === home) return false
  return !reported.startsWith(`${home}${path.sep}`)
}

function matchingStrictRun(input: {
  runs: VerifiedHarnessRun[]
  backtest: ObservedBacktestRun
}): VerifiedHarnessRun | undefined {
  const referenced = input.runs.filter(
    (run) => run.run.runId === input.backtest.runId && path.resolve(run.dir) === path.resolve(input.backtest.artifactDir!),
  )
  return referenced.length === 1 ? referenced[0] : undefined
}

function candidateBindingIssues(input: {
  run: VerifiedHarnessRun
  backtest: ObservedBacktestRun
  savedCandidates: ObservedSavedCandidate[]
}): string[] {
  const issues: string[] = []
  const candidates = input.savedCandidates.filter(
    (candidate) => !input.backtest.algorithmName || candidate.name === input.backtest.algorithmName,
  )
  const candidate = candidates.length === 1 ? candidates[0] : undefined
  if (!candidate?.algorithmId || !Number.isInteger(candidate.version)) {
    issues.push(
      `completed backtest ${input.backtest.algorithmName ?? "<unknown>"} does not bind exactly one saved algorithmId/version`,
    )
    return issues
  }
  if (input.run.run.identity.algorithmId !== candidate.algorithmId) {
    issues.push(`strict run ${input.run.run.runId} algorithmId does not match the saved candidate`)
  }
  if (input.run.run.identity.algorithmVersion !== candidate.version) {
    issues.push(`strict run ${input.run.run.runId} algorithm version does not match the saved candidate`)
  }
  return issues
}

function bindOneBacktest(input: {
  finnyHome: string
  backtest: ObservedBacktestRun
  runs: VerifiedHarnessRun[]
  savedCandidates: ObservedSavedCandidate[]
  scenario: ScenarioIdentity
}): HarnessIntegrityIssue[] {
  const issues: HarnessIntegrityIssue[] = []
  const add = (message: string) => issues.push({ kind: "artifact_integrity", message })
  const label = input.backtest.algorithmName ?? "<unknown>"
  if (!input.backtest.runId || !input.backtest.artifactDir) {
    add(`completed backtest ${label} is missing runId or artifactDir metadata`)
    return issues
  }
  if (outsideFinnyHome(input.finnyHome, input.backtest.artifactDir)) {
    add(`completed backtest ${label} reports an artifactDir outside FINNY_HOME`)
    return issues
  }
  const run = matchingStrictRun({ runs: input.runs, backtest: input.backtest })
  if (!run) {
    add(`completed backtest ${label} does not bind exactly one verified strict run`)
    return issues
  }
  for (const message of candidateBindingIssues({
    run,
    backtest: input.backtest,
    savedCandidates: input.savedCandidates,
  })) {
    add(message)
  }
  issues.push(...scenarioRunIssues(run, input.scenario))
  return issues
}

export function bindObservedStrictRuns(input: {
  finnyHome: string
  savedCandidates: ObservedSavedCandidate[]
  backtests: ObservedBacktestRun[]
  runs: VerifiedHarnessRun[]
  scenario: ScenarioIdentity
}): HarnessIntegrityIssue[] {
  const issues: HarnessIntegrityIssue[] = []
  if (input.backtests.length !== input.runs.length) {
    issues.push({
      kind: "artifact_integrity",
      message: `observed ${input.backtests.length} completed backtest(s), but found ${input.runs.length} verifier-valid strict run artifact(s)`,
    })
  }
  for (const backtest of input.backtests) {
    issues.push(
      ...bindOneBacktest({
        finnyHome: input.finnyHome,
        backtest,
        runs: input.runs,
        savedCandidates: input.savedCandidates,
        scenario: input.scenario,
      }),
    )
  }
  return issues
}

/** Compatibility helper for callers that only have aggregate counts. */
export function expectedBacktestArtifactIssues(
  expectedBacktests: number,
  verifiedRuns: number,
): HarnessIntegrityIssue[] {
  if (expectedBacktests === verifiedRuns) return []
  return [
    {
      kind: "artifact_integrity",
      message: `observed ${expectedBacktests} backtest tool call(s), but found ${verifiedRuns} verifier-valid strict run artifact(s)`,
    },
  ]
}
