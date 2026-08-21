import fs from "node:fs/promises"
import path from "node:path"
import {
  verifyStrictRunDir,
  type RunManifestV1 as StrictRunManifestV1,
  type StrictRunV1,
} from "../../src/backtest/run-integrity"
import { addContentAddressedArtifact, type BundleWriter } from "./artifacts"

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

export type ArtifactCaptureDecision =
  | { include: true; category: "strict_run" | "algorithm_document" | "market_evidence" | "session" | "log" }
  | { include: false; reason: "runtime_directory" | "compiled_runtime" | "legacy_bulk" | "not_allowlisted" }

const RUNTIME_DIRECTORIES = new Set([
  ".venv",
  "node_modules",
  "__pycache__",
  ".cache",
  "cache",
  "caches",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".git",
  "site-packages",
])

const COMPILED_RUNTIME_EXTENSIONS = new Set([
  ".pyc",
  ".pyo",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".o",
  ".a",
  ".class",
  ".wasm",
])

const ALGORITHM_DOCUMENTS = new Set([
  "CURRENT",
  "config.json",
  "decisions.md",
  "memory.md",
  "meta.json",
  "mission.md",
  "prefs.md",
  "reasoning.md",
  "risk.json",
  "strategy.py",
])

const STRICT_RUN_FILES = new Set([
  "approval.json",
  "artifact-manifest.json",
  "asset_spec.json",
  "data_extractor.manifest.json",
  "data_quality.json",
  "diagnostics.csv",
  "durability.json",
  "effective_config.json",
  "engine_tree.json",
  "equity.csv",
  "execution_assumptions.json",
  "execution_profile.json",
  "fills.csv",
  "finny_evidence_equity.csv",
  "live-eligibility.json",
  "metrics.json",
  "ohlcv.csv",
  "orders.csv",
  "processed_ohlcv.csv",
  "rejections.csv",
  "results.json",
  "rolling_sharpe.csv",
  "run.json",
  "trades.csv",
  "validation.json",
])

const LEGACY_DOCUMENTS = new Set(["manifest.json", "mission.md", "request.json", "review.md", "review.html"])
const EVIDENCE_EXTENSIONS = new Set([".csv", ".json", ".jsonl", ".md", ".txt", ".log", ".html"])

function portable(relative: string): string {
  return relative.split(path.sep).join("/")
}

// @codescene(disable-all) Capture policy is the single artifact safety boundary.
export function artifactCaptureDecision(relative: string): ArtifactCaptureDecision {
  const normalized = portable(relative)
  const parts = normalized.split("/").filter(Boolean)
  if (parts.some((part) => RUNTIME_DIRECTORIES.has(part))) {
    return { include: false, reason: "runtime_directory" }
  }
  if (COMPILED_RUNTIME_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    return { include: false, reason: "compiled_runtime" }
  }

  if (normalized === "algorithms/_by-name.json") return { include: true, category: "algorithm_document" }
  if (parts[0] === "algorithms" && parts.length >= 3) {
    const runIndex = parts.indexOf("runs")
    if (runIndex >= 0) {
      const runFile = parts.slice(runIndex + 2)
      const strictName = runFile[0] ?? ""
      return runFile.length === 1 &&
        (STRICT_RUN_FILES.has(strictName) || /^finny_evidence_[a-z0-9_-]+\.csv$/i.test(strictName))
        ? { include: true, category: "strict_run" }
        : { include: false, reason: "not_allowlisted" }
    }
    const dataIndex = parts.indexOf("data")
    if (dataIndex >= 0) {
      return EVIDENCE_EXTENSIONS.has(path.extname(normalized).toLowerCase())
        ? { include: true, category: "market_evidence" }
        : { include: false, reason: "not_allowlisted" }
    }
    return ALGORITHM_DOCUMENTS.has(parts.at(-1)!)
      ? { include: true, category: "algorithm_document" }
      : { include: false, reason: "not_allowlisted" }
  }

  if (parts[0] === "algos") {
    const legacyDocument = parts.length === 3 && LEGACY_DOCUMENTS.has(parts[2]!)
    const finalReviewPacket =
      parts.length === 5 && parts[2] === "reviews" && ["manifest.json", "review.html"].includes(parts[4]!)
    return legacyDocument || finalReviewPacket
      ? { include: true, category: "algorithm_document" }
      : { include: false, reason: "legacy_bulk" }
  }
  if (parts[0] === "session-workspaces" && parts.length === 2) return { include: true, category: "session" }
  if (["sessions", "logs", "evidence"].includes(parts[0] ?? "")) {
    return EVIDENCE_EXTENSIONS.has(path.extname(normalized).toLowerCase())
      ? {
          include: true,
          category: parts[0] === "logs" ? "log" : parts[0] === "sessions" ? "session" : "market_evidence",
        }
      : { include: false, reason: "not_allowlisted" }
  }
  return { include: false, reason: "not_allowlisted" }
}

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

/** Copy only bounded, reviewable Finny evidence before interpreting its schema. */
// @codescene(disable-all) Collection owns the complete evidence-to-manifest boundary.
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
    const source = path.join(input.finnyHome, relative)
    const stat = await fs.stat(source)
    const decision = artifactCaptureDecision(relative)
    if (!decision.include) {
      exclude(excluded, decision.reason, stat.size)
      continue
    }
    if (
      stat.size > limits.maxFileBytes ||
      index.length >= limits.maxFiles ||
      includedBytes + stat.size > limits.maxBytes
    ) {
      exclude(excluded, "capture_limit", stat.size)
      if (!capReported) {
        issues.push({
          kind: "artifact_integrity",
          message: `Finny artifact capture exceeded limits (${limits.maxFiles} files, ${limits.maxBytes} bytes total, ${limits.maxFileBytes} bytes per file)`,
        })
        capReported = true
      }
      continue
    }
    const bytes = await fs.readFile(source)
    const leaked = input.secretValues.find((secret) => bytes.includes(Buffer.from(secret)))
    if (leaked) {
      issues.push({ kind: "secret_integrity", message: `secret value detected in Finny artifact ${relative}` })
      continue
    }
    const artifact = await addContentAddressedArtifact(input.writer, source, "finny-artifact")
    index.push({ source: relative, object: artifact.path, sha256: artifact.sha256, size: artifact.size })
    includedBytes += artifact.size
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
    const file = path.join(finnyHome, relative)
    const dir = path.dirname(file)
    try {
      const verification = await verifyStrictRunDir(dir)
      if (!verification.ok || !verification.run || !verification.manifest) {
        for (const error of verification.errors) {
          issues.push({ kind: "artifact_integrity", message: `${relative}: ${error}` })
        }
        continue
      }
      const parsed = await readObject(file)
      const unifiedVerdict =
        typeof parsed.unifiedVerdict === "string"
          ? parsed.unifiedVerdict
          : typeof (parsed.recommendation as Record<string, unknown> | undefined)?.verdict === "string"
            ? ((parsed.recommendation as Record<string, unknown>).verdict as string)
            : typeof parsed.verdict === "string"
              ? parsed.verdict
              : undefined
      const strategyResult = { artifactPath: relative, ...parsed, ...(unifiedVerdict ? { unifiedVerdict } : {}) }
      results.push(strategyResult)
      runs.push({
        dir,
        artifactPath: relative,
        run: verification.run,
        manifest: verification.manifest,
        assetSpec: await readObject(path.join(dir, "asset_spec.json")),
        dataManifest: await readObject(path.join(dir, "data_extractor.manifest.json")),
        strategyResult,
      })
    } catch (error) {
      issues.push({
        kind: "artifact_integrity",
        message: `${relative}: strict verifier failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return { results, runs, issues }
}

export type ObservedSavedCandidate = {
  name?: string
  algorithmId?: string
  version?: number
  /** Persisted schema-v4 mission, used only when transient tool input omits it. */
  persistedMission?: string
  /** Persisted config JSON, used only when transient tool input omits it. */
  persistedConfig?: string
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

// @codescene(disable-all) Artifact binding intentionally centralizes the strict evidence contract.
function scenarioRunIssues(run: VerifiedHarnessRun, scenario: ScenarioIdentity): HarnessIntegrityIssue[] {
  const issues: HarnessIntegrityIssue[] = []
  const add = (message: string) => issues.push({ kind: "artifact_integrity", message })
  const identity = run.run.identity
  if (
    canonicalDate(identity.dateWindow.start) !== canonicalDate(scenario.startDate) ||
    canonicalDate(identity.dateWindow.end) !== canonicalDate(scenario.endDate) ||
    canonicalInterval(identity.dateWindow.interval) !== canonicalInterval(scenario.interval)
  ) {
    add(`strict run ${run.run.runId} date window does not match scenario`)
  }

  const expectedSymbols = [...new Set(scenario.symbols.map((symbol) => symbol.trim().toUpperCase()))].sort()
  const assetSymbol = String(run.assetSpec.symbol ?? "")
    .trim()
    .toUpperCase()
  if (!assetSymbol || expectedSymbols.length !== 1 || assetSymbol !== expectedSymbols[0]) {
    add(`strict run ${run.run.runId} asset symbol does not match scenario`)
  }
  if (
    canonicalAssetClass(run.assetSpec.assetClass ?? run.assetSpec.asset_class) !==
    canonicalAssetClass(scenario.assetClass)
  ) {
    add(`strict run ${run.run.runId} asset class does not match scenario`)
  }

  const dataSymbols = Array.isArray(run.dataManifest.symbols)
    ? run.dataManifest.symbols.map((symbol) => String(symbol).trim().toUpperCase()).sort()
    : [
        String(run.dataManifest.requested_symbol ?? "")
          .trim()
          .toUpperCase(),
      ].filter(Boolean)
  if (
    dataSymbols.length !== expectedSymbols.length ||
    dataSymbols.some((symbol, index) => symbol !== expectedSymbols[index])
  ) {
    add(`strict run ${run.run.runId} data manifest symbols do not match scenario`)
  }
  const requestedSymbol = String(run.dataManifest.requested_symbol ?? "")
    .trim()
    .toUpperCase()
  const actualSymbol = String(run.dataManifest.actual_symbol ?? requestedSymbol)
    .trim()
    .toUpperCase()
  if (!expectedSymbols.includes(requestedSymbol) || !expectedSymbols.includes(actualSymbol)) {
    add(`strict run ${run.run.runId} data manifest symbol binding does not match scenario`)
  }
  if (
    canonicalInterval(run.dataManifest.requested_interval ?? run.dataManifest.interval) !==
      canonicalInterval(scenario.interval) ||
    canonicalInterval(run.dataManifest.actual_interval ?? run.dataManifest.requested_interval) !==
      canonicalInterval(scenario.interval) ||
    canonicalAssetClass(run.dataManifest.requested_asset_class) !== canonicalAssetClass(scenario.assetClass) ||
    canonicalAssetClass(run.dataManifest.actual_asset_class ?? run.dataManifest.requested_asset_class) !==
      canonicalAssetClass(scenario.assetClass) ||
    canonicalDate(run.dataManifest.requested_start) !== canonicalDate(scenario.startDate) ||
    canonicalDate(run.dataManifest.requested_end) !== canonicalDate(scenario.endDate) ||
    canonicalDate(run.dataManifest.actual_start) !== canonicalDate(scenario.startDate) ||
    canonicalDate(run.dataManifest.actual_end) !== canonicalDate(scenario.endDate) ||
    run.dataManifest.usable_for_parent !== "yes"
  ) {
    add(`strict run ${run.run.runId} data manifest request does not match scenario`)
  }
  if (run.dataManifest.csv_sha256 !== identity.rawDataHash) {
    add(`strict run ${run.run.runId} data manifest CSV hash does not match run identity`)
  }
  return issues
}

// @codescene(disable-all) Strict-run binding centralizes evidence identity validation.
export function bindObservedStrictRuns(input: {
  finnyHome: string
  savedCandidates: ObservedSavedCandidate[]
  backtests: ObservedBacktestRun[]
  runs: VerifiedHarnessRun[]
  scenario: ScenarioIdentity
}): HarnessIntegrityIssue[] {
  const issues: HarnessIntegrityIssue[] = []
  const add = (message: string) => issues.push({ kind: "artifact_integrity", message })
  const publicRunIds = new Set(input.backtests.flatMap((backtest) => (backtest.runId ? [backtest.runId] : [])))
  for (const run of input.runs.filter((candidate) => !publicRunIds.has(candidate.run.runId))) {
    const identity = run.run.identity as StrictRunV1["identity"] & {
      experimentPlanId?: string
      datasetQualification?: string
    }
    const qualification = (run.strategyResult.qualification ?? {}) as Record<string, unknown>
    const context = (qualification.context ?? {}) as Record<string, unknown>
    const phase = String(context.phase ?? "")
    const planId = String(context.planId ?? "")
    const isQualificationPhase =
      /^plan-[a-f0-9]{24}$/i.test(String(identity.experimentPlanId ?? "")) &&
      identity.experimentPlanId === planId &&
      ["exploratory", "validation", "confirmatory"].includes(phase) &&
      identity.datasetQualification === "strict_qualified"
    if (!isQualificationPhase) {
      add(`strict run ${run.run.runId} is neither an observed backtest nor a legal qualification phase`)
      continue
    }
    const candidate = input.savedCandidates.find(
      (saved) => saved.algorithmId === identity.algorithmId && saved.version === identity.algorithmVersion,
    )
    if (!candidate) add(`qualification run ${run.run.runId} does not bind the saved candidate version`)
    const start = canonicalDate(identity.dateWindow.start)
    const end = canonicalDate(identity.dateWindow.end)
    if (start < canonicalDate(input.scenario.startDate) || end > canonicalDate(input.scenario.endDate) || start > end) {
      add(`qualification run ${run.run.runId} falls outside the scenario window`)
    }
  }

  for (const backtest of input.backtests) {
    if (!backtest.runId || !backtest.artifactDir) {
      add(`completed backtest ${backtest.algorithmName ?? "<unknown>"} is missing runId or artifactDir metadata`)
      continue
    }
    const home = path.resolve(input.finnyHome)
    const reportedArtifactDir = path.resolve(backtest.artifactDir)
    if (reportedArtifactDir !== home && !reportedArtifactDir.startsWith(`${home}${path.sep}`)) {
      add(`completed backtest ${backtest.algorithmName ?? "<unknown>"} reports an artifactDir outside FINNY_HOME`)
      continue
    }
    const referenced = input.runs.filter(
      (run) => run.run.runId === backtest.runId && path.resolve(run.dir) === reportedArtifactDir,
    )
    if (referenced.length !== 1) {
      add(`completed backtest ${backtest.algorithmName ?? "<unknown>"} does not bind exactly one verified strict run`)
      continue
    }
    const run = referenced[0]!
    const candidates = input.savedCandidates.filter(
      (candidate) => !backtest.algorithmName || candidate.name === backtest.algorithmName,
    )
    const candidate = candidates.length === 1 ? candidates[0] : undefined
    if (!candidate?.algorithmId || !Number.isInteger(candidate.version)) {
      add(
        `completed backtest ${backtest.algorithmName ?? "<unknown>"} does not bind exactly one saved algorithmId/version`,
      )
    } else {
      if (run.run.identity.algorithmId !== candidate.algorithmId) {
        add(`strict run ${run.run.runId} algorithmId does not match the saved candidate`)
      }
      if (run.run.identity.algorithmVersion !== candidate.version) {
        add(`strict run ${run.run.runId} algorithm version does not match the saved candidate`)
      }
    }
    issues.push(...scenarioRunIssues(run, input.scenario))
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
