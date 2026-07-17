import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { finnyHomeArtifacts } from "@finny-ai/core/prefs"
import { Algorithm } from "@/algorithm"
import { resolveAlgorithmFolder } from "@/algorithm/folder"
import { BacktestStore } from "./store"
import { readSpec, readTrialEvents } from "./experiment-store"
import type { ExperimentSpec, TrialEvent } from "./experiment-types"
import { svgHeatmap, svgReportLineChart } from "./svg-charts"
import { isRobustQualifiedResult } from "./verdict"

export type ReviewConclusion = "recommended_for_paper" | "research_complete" | "concept_exhausted" | "optimization_exhausted" | "blocked" | "user_stopped"

export interface QuantReviewRun {
  manifest: BacktestStore.Manifest
  event?: TrialEvent
  verdict: string
  reasons: string[]
  equity: number[]
  equityLabels: string[]
  benchmark: number[]
  rollingSharpe: number[]
  monthlyReturns: Record<string, Record<string, number>>
  foldSharpes: number[]
  decay?: Record<string, any>
  consistency?: Record<string, any>
  robustness?: Record<string, any>
  identity?: Record<string, any>
  metrics: Record<string, number | null | undefined>
  lineageRuns?: QuantReviewRun[]
  warnings: string[]
}

export interface WorkflowReviewQualification {
  workflowId: string
  phase: string
  status: string
  runId: string
  identityHash: string
  verdict: string
}

export interface QuantReviewData {
  algorithm: Algorithm.Info
  versions: Algorithm.Info[]
  specs: ExperimentSpec[]
  events: TrialEvent[]
  runs: QuantReviewRun[]
  experimentId: string
  conclusion: ReviewConclusion
  conclusionReason: string
  generatedAt: string
  qualification: WorkflowReviewQualification
}

type TerminalReviewInput = Pick<QuantReviewData, "experimentId" | "conclusion" | "specs" | "events" | "runs" | "qualification"> & {
  algorithmId: string
}

type TerminalEvidence = {
  input: TerminalReviewInput
  terminalSpec?: ExperimentSpec
  completed: TrialEvent[]
  terminalCompleted: TrialEvent[]
  terminalRunIds: Set<string>
  startedTrialCount: number
  failedRunStreak: number
}

function lineageErrors(input: TerminalReviewInput): string[] {
  const byId = new Map(input.specs.map((spec) => [spec.experimentId, spec]))
  let current = byId.get(input.experimentId)
  if (!current) return ["selected experiment spec is missing"]
  const seen = new Set<string>()
  while (current.parentExperimentId && !seen.has(current.experimentId)) {
    seen.add(current.experimentId)
    const parent = byId.get(current.parentExperimentId)
    if (!parent) return [`experiment lineage ancestor spec is missing or corrupt: ${current.parentExperimentId}`]
    current = parent
  }
  return []
}

function failedRunStreak(events: TrialEvent[], persistedRunIds: Set<string>): number {
  let streak = 0
  let previousTrialId: string | undefined
  for (const event of events) {
    const persistedFailure = event.outcome === "failed" && event.runId && persistedRunIds.has(event.runId)
    if (!persistedFailure) {
      streak = 0
      previousTrialId = undefined
      continue
    }
    if (event.trialId !== previousTrialId) streak += 1
    previousTrialId = event.trialId
  }
  return streak
}

function terminalEvidence(input: TerminalReviewInput): TerminalEvidence {
  const events = input.events.filter((event) => event.algorithmId === input.algorithmId)
  const completed = events.filter((event) => event.event === "completed")
  const terminalCompleted = completed.filter((event) => event.experimentId === input.experimentId)
  const terminalRunIds = new Set(terminalCompleted.flatMap((event) => event.runId ? [event.runId] : []))
  const startedTrialIds = events
    .filter((event) => event.experimentId === input.experimentId && event.event === "started")
    .map((event) => event.trialId)
  return {
    input,
    terminalSpec: input.specs.find((spec) => spec.experimentId === input.experimentId),
    completed,
    terminalCompleted,
    terminalRunIds,
    startedTrialCount: new Set(startedTrialIds).size,
    failedRunStreak: failedRunStreak(completed, new Set(input.runs.map((run) => run.manifest.id))),
  }
}

function baseEvidenceErrors(evidence: TerminalEvidence): string[] {
  const errors: string[] = []
  if (!evidence.input.events.some((event) => event.algorithmId === evidence.input.algorithmId)) {
    errors.push("experiment lineage has no trial evidence for the selected algorithm")
  }
  if (!evidence.terminalCompleted.length) errors.push("selected experiment is not terminal for the selected algorithm")
  return errors
}

function terminalRun(evidence: TerminalEvidence): QuantReviewRun | undefined {
  const terminalRunId = evidence.terminalCompleted.at(-1)?.runId
  return terminalRunId
    ? evidence.input.runs.find((run) => run.manifest.id === terminalRunId)
    : undefined
}

type PositivePerformanceMetric = {
  value: unknown
  missingError: string
  nonPositiveError: string
}

function positivePerformanceError(metric: PositivePerformanceMetric): string | undefined {
  if (!finite(metric.value)) return metric.missingError
  return metric.value > 0 ? undefined : metric.nonPositiveError
}

function performanceEligibilityErrors(evidence: TerminalEvidence): string[] {
  const run = terminalRun(evidence)
  const metrics: PositivePerformanceMetric[] = [
    {
      value: run?.manifest.alpha ?? run?.metrics.alpha,
      missingError: "final review requires a persisted terminal run with a buy-and-hold alpha comparison",
      nonPositiveError: "final review is produced only when the strategy beats buy-and-hold (terminal alpha must be > 0)",
    },
    {
      value: run?.manifest.results.totalReturn ?? run?.metrics.totalReturn,
      missingError: "final review requires a persisted terminal backtest return",
      nonPositiveError: "final review is produced only when the terminal backtest return is > 0",
    },
    {
      value: run?.robustness?.stitched_oos_return,
      missingError: "final review requires a persisted stitched walk-forward OOS return",
      nonPositiveError: "final review is produced only when the stitched walk-forward OOS return is > 0",
    },
  ]
  return metrics.map(positivePerformanceError).filter((error): error is string => error !== undefined)
}

function robustQualificationError(evidence: TerminalEvidence): string | undefined {
  const run = terminalRun(evidence)
  return isRobustQualifiedResult({
    verdict: run?.verdict,
    totalReturn: run?.manifest.results.totalReturn ?? run?.metrics.totalReturn,
    stitchedOosReturn: run?.robustness?.stitched_oos_return,
    alpha: run?.manifest.alpha ?? run?.metrics.alpha,
  })
    ? undefined
    : "final review requires a persisted terminal recommended_for_paper run that passed deterministic robustness and all positive return/OOS/alpha gates"
}

function workflowQualificationErrors(evidence: TerminalEvidence): string[] {
  const qualification = evidence.input.qualification
  const run = terminalRun(evidence)
  const errors: string[] = []
  if (qualification.workflowId !== evidence.input.experimentId) {
    errors.push("final review qualification workflowId must match the selected experimentId")
  }
  const qualifiedActive = qualification.phase === "qualified" && qualification.status === "active"
  const qualifiedTerminal = qualification.phase === "terminal_complete" && qualification.status === "completed"
  if (!qualifiedActive && !qualifiedTerminal) {
    errors.push("final review requires an authoritative qualified WorkflowRun")
  }
  if (qualification.verdict !== "recommended_for_paper") {
    errors.push("final review WorkflowRun verdict must be recommended_for_paper")
  }
  if (!run || qualification.runId !== run.manifest.id) {
    errors.push("final review terminal runId must match the qualified WorkflowRun backtest")
  }
  if (!run?.identity?.identityHash || qualification.identityHash !== run.identity.identityHash) {
    errors.push("final review terminal identityHash must match the qualified WorkflowRun backtest")
  }
  return errors
}

type ConclusionValidator = (evidence: TerminalEvidence) => string | undefined

const conclusionValidators: Record<ReviewConclusion, ConclusionValidator> = {
  recommended_for_paper: (evidence) => {
    const recommended = evidence.input.runs.some(
      (run) => evidence.terminalRunIds.has(run.manifest.id) && run.verdict === "recommended_for_paper",
    )
    return recommended ? undefined : "recommended_for_paper requires a matching persisted recommended run"
  },
  research_complete: (evidence) => {
    const run = terminalRun(evidence)
    if (!run) return "research_complete requires a matching persisted terminal run"
    return run.verdict === "recommended_for_paper"
      ? "research_complete cannot replace a recommended_for_paper conclusion"
      : undefined
  },
  concept_exhausted: (evidence) => evidence.failedRunStreak >= 5
    ? undefined
    : `concept_exhausted requires 5 consecutive completed failed trials with persisted metric runs (current streak ${evidence.failedRunStreak})`,
  optimization_exhausted: (evidence) => {
    const budget = evidence.terminalSpec?.optimizationBudget
    return budget === undefined || evidence.startedTrialCount >= budget
      ? undefined
      : `optimization_exhausted requires ${budget} uniquely started trials in the selected experiment (found ${evidence.startedTrialCount})`
  },
  blocked: (evidence) => {
    const hardBlocker = evidence.terminalCompleted.some(
      (event) => event.outcome === "blocked" || (event.outcome === "failed" && !event.runId),
    )
    return hardBlocker ? undefined : "blocked requires a completed blocked outcome or a failed no-run hard blocker"
  },
  user_stopped: (evidence) => evidence.terminalCompleted.length
    ? undefined
    : "user_stopped requires matching persisted completed trial evidence",
}

function conclusionError(evidence: TerminalEvidence): string | undefined {
  return conclusionValidators[evidence.input.conclusion](evidence)
}

export function validateTerminalReview(input: TerminalReviewInput): string[] {
  const evidence = terminalEvidence(input)
  const errors = [...lineageErrors(input), ...baseEvidenceErrors(evidence)]
  errors.push(...workflowQualificationErrors(evidence))
  errors.push(...performanceEligibilityErrors(evidence))
  const robustError = robustQualificationError(evidence)
  if (robustError) errors.push(robustError)
  if (input.conclusion !== "recommended_for_paper") {
    errors.push("final review conclusion must be recommended_for_paper; unqualified research must continue iteration without a final packet")
  }
  const terminalError = conclusionError(evidence)
  if (terminalError) errors.push(terminalError)
  return errors
}

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const pct = (value: unknown) => finite(value) ? `${(value * 100).toFixed(2)}%` : "N/A"
const num = (value: unknown, digits = 2) => finite(value) ? value.toFixed(digits) : "N/A"

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  const headers = lines.shift()?.split(",") ?? []
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split(",")[index] ?? ""])))
}

async function csv(file: string | undefined): Promise<Record<string, string>[]> {
  if (!file) return []
  try { return parseCsv(await fs.readFile(file, "utf8")) } catch { return [] }
}

async function json(file: string | undefined): Promise<any> {
  if (!file) return undefined
  try { return JSON.parse(await fs.readFile(file, "utf8")) } catch { return undefined }
}

async function lineage(experimentId: string): Promise<ExperimentSpec[]> {
  const specs: ExperimentSpec[] = []
  const seen = new Set<string>()
  let current: string | undefined = experimentId
  while (current && !seen.has(current)) {
    seen.add(current)
    const spec = await readSpec({ experimentId: current })
    if (!spec) throw new Error(`experiment lineage spec is missing or corrupt: ${current}`)
    specs.push(spec)
    current = spec.parentExperimentId
  }
  return specs.reverse()
}

function safeArtifactSegment(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value)
}

export function canonicalStrictRunArtifactDir(
  manifest: BacktestStore.Manifest,
  algorithmsRoot = finnyHomeArtifacts().algorithms,
): string | undefined {
  if (!safeArtifactSegment(manifest.algorithmId) || !safeArtifactSegment(manifest.id)) return undefined
  if (!Number.isSafeInteger(manifest.algorithmVersion) || manifest.algorithmVersion < 0) return undefined
  return path.join(
    algorithmsRoot,
    manifest.algorithmId,
    `v${String(manifest.algorithmVersion).padStart(2, "0")}`,
    "runs",
    manifest.id,
  )
}

function artifactRoots(manifest: BacktestStore.Manifest, algorithmsRoot?: string): string[] {
  const roots = [
    manifest.dir,
    manifest.artifacts.sourceArtifacts,
    canonicalStrictRunArtifactDir(manifest, algorithmsRoot),
  ].filter((item): item is string => Boolean(item))
  return [...new Set(roots)]
}

async function firstJson(roots: string[], filename: string): Promise<any> {
  for (const root of roots) {
    const value = await json(path.join(root, filename))
    if (value !== undefined) return value
  }
}

async function equityRows(manifest: BacktestStore.Manifest, roots: string[]) {
  const stored = manifest.dir && manifest.artifacts.equityCurve
    ? await csv(path.join(manifest.dir, manifest.artifacts.equityCurve))
    : []
  if (stored.length) return stored
  return csv(roots[1] ? path.join(roots[1], "finny_evidence_equity.csv") : undefined)
}

function numeric(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function numericColumn(rows: Record<string, string>[], key: string, fallback?: string): number[] {
  return rows
    .map((row) => numeric(row[key] ?? (fallback ? row[fallback] : undefined)))
    .filter(finite)
}

function foldSharpes(run: any, durability: any): number[] {
  const folds = run?.metrics?.walk_forward?.folds ?? durability?.baseline?.foldOosSharpes ?? []
  return folds.map((fold: any) => numeric(fold?.oos_sharpe ?? fold)).filter(finite)
}

function runIdentity(run: any): Record<string, any> | undefined {
  if (!run?.identity) return undefined
  return { ...run.identity, identityHash: run.identityHash, engine: run.engine, artifactHashes: run.artifactHashes }
}

type HydratedArtifacts = {
  run: any
  metrics: any
  durability: any
  equity: Record<string, string>[]
  rolling: Record<string, string>[]
}

async function hydratedArtifacts(manifest: BacktestStore.Manifest, algorithmsRoot?: string): Promise<HydratedArtifacts> {
  const roots = artifactRoots(manifest, algorithmsRoot)
  const rollingPath = roots[1] ? path.join(roots[1], "rolling_sharpe.csv") : undefined
  const [run, metricsFile, durability, equity, rolling] = await Promise.all([
    firstJson(roots, "run.json"),
    firstJson(roots, "metrics.json"),
    firstJson(roots, "durability.json"),
    equityRows(manifest, roots),
    csv(rollingPath),
  ])
  return { run, metrics: normalizeMetricsDocument(run?.metrics ?? metricsFile), durability, equity, rolling }
}

function reviewVerdict(manifest: BacktestStore.Manifest, event: TrialEvent | undefined, artifacts: HydratedArtifacts) {
  return artifacts.run?.recommendation?.verdict
    ?? artifacts.durability?.verdict
    ?? manifest.results.eligibilityStatus
    ?? event?.outcome
    ?? "unknown"
}

function reviewReasons(event: TrialEvent | undefined, artifacts: HydratedArtifacts): string[] {
  return artifacts.run?.recommendation?.reasons
    ?? artifacts.durability?.reasons
    ?? (event?.details ? [event.details] : [])
}

function reviewWarnings(artifacts: HydratedArtifacts): string[] {
  const warnings: string[] = []
  if (!artifacts.run) warnings.push("immutable run.json unavailable")
  if (!artifacts.equity.length) warnings.push("equity series unavailable")
  return warnings
}

function reviewSeries(artifacts: HydratedArtifacts) {
  return {
    equity: numericColumn(artifacts.equity, "strategy_equity", "equity"),
    equityLabels: artifacts.equity.map((row) => row.timestamp ?? row.ts ?? row.date ?? ""),
    benchmark: numericColumn(artifacts.equity, "benchmark_equity"),
    rollingSharpe: numericColumn(artifacts.rolling, "rolling_sharpe"),
  }
}

export function normalizeMetricsDocument(document: any): any {
  return document?.v2 ?? document ?? {}
}

export function extractCoreMetrics(manifest: BacktestStore.Manifest, metricsDocument: any) {
  const metrics = normalizeMetricsDocument(metricsDocument)
  const exposure = metrics.exposure ?? {}
  const returns = metrics.returns ?? metrics.return ?? {}
  const trade = metrics.trade ?? {}
  const ratios = metrics.ratios ?? {}
  const risk = metrics.risk ?? {}
  return {
    totalReturn: manifest.results.totalReturn,
    alpha: manifest.alpha,
    sharpe: manifest.results.sharpeRatio,
    sortino: ratios.sortino ?? metrics.sortino,
    calmar: ratios.calmar ?? metrics.calmar,
    maxDrawdown: manifest.results.maxDrawdown,
    annualizedVolatility: risk.ann_vol ?? metrics.annualized_volatility ?? manifest.results.annualizedVolatility,
    profitFactor: trade.profit_factor ?? metrics.profit_factor ?? manifest.results.profitFactor,
    winRate: manifest.results.winRate,
    trades: trade.total_trades ?? metrics.total_trades ?? manifest.results.totalTrades,
    expectancy: trade.expectancy ?? metrics.expectancy,
    cagr: returns.cagr ?? metrics.cagr,
    omega: ratios.omega ?? metrics.omega,
    timeInMarket: exposure.time_in_market_pct ?? metrics.time_in_market_pct ?? metrics.time_in_market,
    turnover: exposure.total_turnover ?? metrics.total_turnover ?? metrics.turnover,
    avgGrossExposure: exposure.avg_gross_exposure ?? metrics.avg_gross_exposure,
    avgNetExposure: exposure.avg_net_exposure ?? metrics.avg_net_exposure,
  }
}

function coreMetrics(manifest: BacktestStore.Manifest, artifacts: HydratedArtifacts) {
  return extractCoreMetrics(manifest, artifacts.metrics)
}

function stabilityStatistics(artifacts: HydratedArtifacts) {
  return {
    monthlyReturns: artifacts.run?.metrics?.stability?.monthly_returns
      ?? artifacts.durability?.baseline?.monthlyReturns
      ?? {},
  }
}

function walkForwardStatistics(artifacts: HydratedArtifacts) {
  return {
    foldSharpes: foldSharpes(artifacts.run, artifacts.durability),
    robustness: artifacts.metrics?.walk_forward,
  }
}

function durabilityStatistics(artifacts: HydratedArtifacts) {
  return {
    decay: artifacts.run?.metrics?.alpha_decay ?? artifacts.durability?.decay,
    consistency: artifacts.run?.metrics?.consistency ?? artifacts.durability?.consistency,
  }
}

function reviewSummary(
  manifest: BacktestStore.Manifest,
  event: TrialEvent | undefined,
  artifacts: HydratedArtifacts,
) {
  return {
    verdict: reviewVerdict(manifest, event, artifacts),
    reasons: reviewReasons(event, artifacts),
    identity: runIdentity(artifacts.run),
    warnings: reviewWarnings(artifacts),
    metrics: coreMetrics(manifest, artifacts),
  }
}

function assembleReviewRun(
  manifest: BacktestStore.Manifest,
  event: TrialEvent | undefined,
  artifacts: HydratedArtifacts,
): QuantReviewRun {
  return {
    manifest,
    event,
    ...reviewSummary(manifest, event, artifacts),
    ...reviewSeries(artifacts),
    ...stabilityStatistics(artifacts),
    ...walkForwardStatistics(artifacts),
    ...durabilityStatistics(artifacts),
  }
}

export async function hydrateReviewRun(
  manifest: BacktestStore.Manifest,
  event?: TrialEvent,
  algorithmsRoot?: string,
): Promise<QuantReviewRun> {
  return assembleReviewRun(manifest, event, await hydratedArtifacts(manifest, algorithmsRoot))
}

function codeDiffSummary(previous: Algorithm.Info | undefined, current: Algorithm.Info): string {
  if (!previous) return "Initial saved implementation."
  const changed: string[] = []
  if (previous.code !== current.code) changed.push("strategy code")
  if (previous.config !== current.config) changed.push("configuration")
  if (previous.mission !== current.mission) changed.push("mission")
  if (previous.riskContract !== current.riskContract) changed.push("risk contract")
  return changed.length ? `Changed ${changed.join(", ")}.` : "No material saved-field change detected."
}

function displayMetric(
  label: string,
  value: unknown,
  format: "percent" | "ratio" | "number" | "currency" = "ratio",
) {
  const shown = format === "percent"
    ? pct(value)
    : format === "number"
      ? num(value, 1)
      : format === "currency"
        ? finite(value) ? `$${value.toFixed(2)}` : "N/A"
        : num(value)
  return `<div class="metric"><span>${esc(label)}</span><strong>${esc(shown)}</strong></div>`
}

function metricsStrip(run?: QuantReviewRun) {
  const m = run?.metrics ?? {}
  return `<section class="metrics" aria-label="Backtest metrics">${[
    displayMetric("Total return", m.totalReturn, "percent"), displayMetric("Alpha", m.alpha, "percent"),
    displayMetric("Sharpe", m.sharpe), displayMetric("Sortino", m.sortino), displayMetric("Calmar", m.calmar),
    displayMetric("Max drawdown", m.maxDrawdown, "percent"), displayMetric("Ann. volatility", m.annualizedVolatility, "percent"),
    displayMetric("Profit factor", m.profitFactor), displayMetric("Win rate", m.winRate, "percent"),
    displayMetric("Trades", m.trades, "number"), displayMetric("Expectancy", m.expectancy, "number"), displayMetric("CAGR", m.cagr, "percent"),
  ].join("")}</section>`
}

function detailPopover(id: string, label: string, body: string) {
  return `<button class="summary-button" popovertarget="${id}"><span>${esc(label)}</span><b>View details ↗</b></button><div class="detail-popover" popover id="${id}"><button class="close" popovertarget="${id}" popovertargetaction="hide">Close</button>${body}</div>`
}

function comparisonValue(value: unknown, format: "percent" | "ratio" | "number" = "ratio") {
  return format === "percent" ? pct(value) : format === "number" ? num(value, 1) : num(value)
}

function runComparison(runs: QuantReviewRun[]) {
  const rows = runs.map((run) => {
    const m = run.metrics
    return `<tr><th>v${run.manifest.algorithmVersion}<small>${esc(run.manifest.id)}</small></th><td>${comparisonValue(m.totalReturn, "percent")}</td><td>${comparisonValue(m.alpha, "percent")}</td><td>${comparisonValue(m.sharpe)}</td><td>${comparisonValue(m.sortino)}</td><td>${comparisonValue(m.calmar)}</td><td>${comparisonValue(m.maxDrawdown, "percent")}</td><td>${comparisonValue(m.profitFactor)}</td><td>${comparisonValue(m.winRate, "percent")}</td><td>${comparisonValue(m.trades, "number")}</td><td><b>${esc(run.verdict)}</b><small>${esc(run.reasons.join("; ") || "No persisted reasons.")}</small></td></tr>`
  }).join("")
  return `<div class="comparison" style="overflow:auto;border:1px solid #dedbd3;border-radius:7px"><table style="width:100%;border-collapse:collapse;font-size:10px"><thead><tr><th>Run</th><th>Return</th><th>Alpha</th><th>Sharpe</th><th>Sortino</th><th>Calmar</th><th>Max DD</th><th>PF</th><th>Win rate</th><th>Trades</th><th>Verdict / reasons</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

function extendedMetrics(run?: QuantReviewRun) {
  const m = run?.metrics ?? {}
  return `<div class="metrics" style="grid-template-columns:repeat(5,1fr)">${displayMetric("Omega", m.omega)}${displayMetric("Time in market", m.timeInMarket, "percent")}${displayMetric("Turnover", m.turnover, "number")}${displayMetric("Avg gross notional", m.avgGrossExposure, "currency")}${displayMetric("Avg net notional", m.avgNetExposure, "currency")}</div>`
}

function summaryButtons(run?: QuantReviewRun) {
  const comparisonRuns = run?.lineageRuns ?? (run ? [run] : [])
  const backtest = `<h2>Backtest Results</h2>${runComparison(comparisonRuns)}${extendedMetrics(run)}<p><b>Latest assumptions:</b> fee ${num(run?.manifest.assumptions?.feeBps, 1)} bps · slippage ${num(run?.manifest.assumptions?.slippageBps, 1)} bps · ${esc(run?.manifest.assumptions?.fillModel ?? "N/A")}</p>`
  const walk = `<h2>Walk-forward Test</h2><p><b>Folds:</b> ${esc(run?.robustness?.n_folds ?? run?.foldSharpes.length ?? "N/A")}</p><p><b>OOS Sharpe mean:</b> ${num(run?.robustness?.oos_sharpe_mean)} · <b>OOS decay:</b> ${num(run?.robustness?.oos_decay)}</p><p><b>Coverage:</b> ${esc(run?.manifest.params?.startDate ?? "N/A")} → ${esc(run?.manifest.params?.endDate ?? "N/A")} · ${esc(run?.manifest.params?.interval ?? "N/A")}</p>`
  const decay = `<h2>Alpha Decay Test</h2><p><b>Result:</b> ${esc(run?.decay?.label ?? "N/A")} · ${esc(run?.decay?.confidence ?? "unknown confidence")}</p><p><b>Trend:</b> ${esc(run?.decay?.mann_kendall?.trend ?? "N/A")} · <b>Fold slope:</b> ${num(run?.decay?.fold_slope?.slope, 3)}</p><p><b>Cost breakeven:</b> ${esc(run?.decay?.breakeven?.months ?? run?.decay?.breakeven?.status ?? "N/A")}</p>`
  return `<section class="summaries">${detailPopover("backtest-detail", "Backtest Results", backtest)}${detailPopover("walk-detail", "Walk-forward Test", walk)}${detailPopover("decay-detail", "Alpha Decay Test", decay)}</section>`
}

function versionAudit(data: QuantReviewData) {
  const versions = [...data.versions].sort((a, b) => a.version - b.version)
  return versions.map((version, index) => {
    const trials = data.events.filter((event) => event.algorithmVersion === version.version)
    const runs = data.runs.filter((run) => run.manifest.algorithmVersion === version.version)
    return `<details><summary>v${version.version} — ${esc(codeDiffSummary(versions[index - 1], version))}</summary><div class="audit"><p>${esc(version.reasoning ?? version.description ?? "No saved rationale.")}</p>${runs.length ? runComparison(runs) : ""}${trials.map((trial) => `<p><b>${esc(trial.trialId)} · ${esc(trial.event)}${trial.outcome ? `/${esc(trial.outcome)}` : ""}</b><br>${esc(trial.details ?? (trial.runId ? `run ${trial.runId}` : "No run was produced."))}<br><small>codeHash=${esc(trial.codeHash)} · configHash=${esc(trial.configHash)} · dataHash=${esc(trial.actualDataHash ?? "N/A")}</small></p>`).join("")}<details><summary>Saved code and configuration</summary><pre>${esc(version.code)}</pre><pre>${esc(version.config ?? "No config")}</pre></details></div></details>`
  }).join("")
}

const REPORT_CSS = `:root{color-scheme:light;--ink:#171715;--muted:#6d6b65;--line:#dedbd3;--paper:#fbfaf7;--accent:#8b641c}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:13px Inter,ui-sans-serif,system-ui,sans-serif;line-height:1.45}main{max-width:980px;margin:auto;padding:28px 22px 56px}header{border-bottom:1px solid var(--line);padding-bottom:16px}.eyebrow,h2.section{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:700}h1{font-size:30px;letter-spacing:-.04em;margin:4px 0}.verdict{display:inline-block;border:1px solid var(--ink);border-radius:999px;padding:3px 9px;font-size:11px}.boundary{margin:8px 0 0;color:var(--muted)}.metrics{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid var(--line);border-radius:8px;margin:14px 0;overflow:hidden;background:white}.metric{padding:9px 10px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.metric span{display:block;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.metric strong{font-size:16px}.summaries{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 0}.summary-button{appearance:none;text-align:left;background:white;border:1px solid var(--line);border-radius:7px;padding:12px;color:var(--ink);cursor:pointer}.summary-button span,.summary-button b{display:block}.summary-button b{font-size:10px;color:var(--accent);margin-top:8px}.detail-popover{width:min(680px,calc(100vw - 28px));max-height:80vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:20px;background:white;color:var(--ink);box-shadow:0 20px 60px #0002}.detail-popover::backdrop{background:#0004}.close{float:right;border:0;background:#f0eee8;padding:6px 9px;border-radius:5px}.mandate,.chart,.audit{background:white;border:1px solid var(--line);border-radius:8px;padding:14px}.charts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.chart h3{font-size:11px;margin:0 0 6px}.report-chart{width:100%;height:auto}.report-chart text{font:9px system-ui;fill:#6d6b65}.report-chart .baseline{stroke:#777;stroke-dasharray:3 3}details{border-top:1px solid var(--line);padding:9px 0}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;word-break:break-word;background:#f4f2ed;padding:10px;font-size:11px}.deep{margin-top:18px}.empty{color:var(--muted)}@media(max-width:760px){.metrics{grid-template-columns:repeat(3,1fr)}.summaries,.charts{grid-template-columns:1fr}}@media(max-width:440px){.metrics{grid-template-columns:repeat(2,1fr)}main{padding:20px 14px}}`

function decisionBoundary(conclusion: ReviewConclusion) {
  if (conclusion === "recommended_for_paper") return "Human review is required before finny_paper_approve. No paper eligibility is granted by this packet."
  if (conclusion === "research_complete") return "Research completed with benchmark outperformance, but this packet does not recommend or approve paper trading."
  if (conclusion === "user_stopped") return "Research was stopped by the user; this is not a statistical rejection or promotion decision."
  return "Do not promote. Resolve the listed failure or start a new hypothesis."
}

function renderHeader(data: QuantReviewData, stop: string) {
  return `<header><div class="eyebrow">Final quant review · ${esc(data.generatedAt)}</div><h1>${esc(data.algorithm.name)}</h1><span class="verdict">${esc(data.conclusion)}</span><p>${esc(data.conclusionReason)}</p><p class="boundary"><b>Decision boundary:</b> ${esc(stop)}</p></header>`
}

function renderMandate(data: QuantReviewData) {
  const specs = data.specs.map((spec) => `<b>${esc(spec.experimentId)}</b><p>${esc(spec.hypothesis)}</p><small>${esc(spec.universe.join(", "))} · ${esc(spec.interval)} · benchmark ${esc(spec.benchmark)} · costs ${esc(spec.costs)}</small>`).join("")
  return `<h2 class="section">Mandate</h2><section class="mandate">${specs}</section>`
}

function equityEvidence(run?: QuantReviewRun) {
  if (!run?.equity.length) return ""
  const series = [{ label: "Strategy", values: run.equity, color: "#121212" }]
  if (run.benchmark.length) series.push({ label: "Benchmark", values: run.benchmark, color: "#9a8f7a" })
  return `<div class="chart"><h3>Equity vs benchmark</h3>${svgReportLineChart({ series, labels: run.equityLabels, format: "number" })}</div>`
}

function decayEvidence(run?: QuantReviewRun) {
  if (!run?.foldSharpes.length) return ""
  const series = [{ label: "OOS Sharpe by fold", values: run.foldSharpes, color: "#996515" }]
  const labels = run.foldSharpes.map((_, index) => `Fold ${index + 1}`)
  return `<div class="chart"><h3>Alpha decay · OOS Sharpe by fold</h3>${svgReportLineChart({ series, labels, format: "ratio" })}</div>`
}

function monthlyEvidence(run?: QuantReviewRun) {
  if (!Object.keys(run?.monthlyReturns ?? {}).length) return ""
  return `<div class="chart"><h3>Monthly returns</h3>${svgHeatmap(run!.monthlyReturns, 640, 24)}</div>`
}

function renderEvidence(run?: QuantReviewRun) {
  return `<h2 class="section">Performance evidence</h2><section class="charts">${equityEvidence(run)}${decayEvidence(run)}${monthlyEvidence(run)}</section>`
}

function reproducibilityAudit(data: QuantReviewData, run?: QuantReviewRun) {
  const warnings = [...new Set(data.runs.flatMap((item) => item.warnings))].join("; ") || "None"
  return `<details><summary>Statistical and reproducibility review</summary><div class="audit"><p>Lineage: ${data.specs.map((spec) => esc(spec.experimentId)).join(" → ")}</p><p>Immutable run identity: ${esc(run?.identity ? JSON.stringify(run.identity) : "N/A")}</p><p>Evidence gaps: ${esc(warnings)}</p></div></details>`
}

function failureAudit(data: QuantReviewData, stop: string) {
  const events = data.events.filter((event) => event.event === "completed").map((event) => `<p><b>v${event.algorithmVersion} · ${esc(event.trialId)}</b> ${esc(event.outcome ?? "completed")} — ${esc(event.details ?? "No persisted reason.")}</p>`).join("")
  return `<details><summary>Failure analysis and next action</summary><div class="audit">${events}<p><b>Next action:</b> ${esc(stop)}</p></div></details>`
}

function renderAudits(data: QuantReviewData, run: QuantReviewRun | undefined, stop: string) {
  return `<section class="deep"><h2 class="section">Audit trail</h2>${versionAudit(data)}${reproducibilityAudit(data, run)}${failureAudit(data, stop)}</section>`
}

function reportDocument(data: QuantReviewData, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Quant Review — ${esc(data.algorithm.name)}</title><style>${REPORT_CSS}</style></head><body><main>${body}</main></body></html>`
}

export function renderQuantReviewHtml(data: QuantReviewData): string {
  const current = data.runs.at(-1)
  const latest = current ? { ...current, lineageRuns: data.runs } : undefined
  const stop = decisionBoundary(data.conclusion)
  const body = renderHeader(data, stop) + metricsStrip(latest) + summaryButtons(latest) + renderMandate(data) + renderEvidence(latest) + renderAudits(data, latest, stop)
  return reportDocument(data, body)
}

type FinalReviewInput = {
  algorithm: Algorithm.Info
  experimentId: string
  conclusion: ReviewConclusion
  conclusionReason: string
  qualification: WorkflowReviewQualification
}

async function lineageEvents(specs: ExperimentSpec[], algorithmId: string): Promise<TrialEvent[]> {
  const groups = await Promise.all(specs.map((spec) => readTrialEvents({ experimentId: spec.experimentId })))
  return groups
    .flat()
    .filter((event) => event.algorithmId === algorithmId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

function runEventIndex(events: TrialEvent[]): Map<string, TrialEvent> {
  const completed = events.filter((event) => event.event === "completed" && event.runId)
  return new Map(completed.map((event) => [event.runId!, event]))
}

function participatingManifests(
  manifests: BacktestStore.Manifest[],
  eventsByRun: Map<string, TrialEvent>,
  experimentIds: Set<string>,
): BacktestStore.Manifest[] {
  return manifests
    .filter((manifest) => {
      const event = eventsByRun.get(manifest.id)
      const experimentId = manifest.experiment?.experimentId ?? event?.experimentId
      return event !== undefined && experimentId !== undefined && experimentIds.has(experimentId)
    })
    .sort((a, b) => a.timestamp - b.timestamp)
}

async function reviewData(input: FinalReviewInput, specs: ExperimentSpec[]): Promise<{
  data: QuantReviewData
  manifests: BacktestStore.Manifest[]
}> {
  const experimentIds = new Set(specs.map((spec) => spec.experimentId))
  const events = await lineageEvents(specs, input.algorithm.algorithmId)
  const eventsByRun = runEventIndex(events)
  const history = await BacktestStore.list({ algorithmId: input.algorithm.algorithmId, limit: 1000 })
  const manifests = participatingManifests(history, eventsByRun, experimentIds)
  const runs = await Promise.all(manifests.map((manifest) => hydrateReviewRun(manifest, eventsByRun.get(manifest.id))))
  const participatingVersions = new Set(events.map((event) => event.algorithmVersion))
  const versions = (await Algorithm.listVersions(input.algorithm.algorithmId))
    .filter((version) => participatingVersions.has(version.version))
  return {
    manifests,
    data: { ...input, specs, events, runs, versions, generatedAt: new Date().toISOString() },
  }
}

async function reviewDirectory(input: FinalReviewInput): Promise<string> {
  const artifacts = finnyHomeArtifacts()
  const resolved = await resolveAlgorithmFolder({
    algorithmId: input.algorithm.algorithmId,
    name: input.algorithm.name,
    algosRoot: artifacts.algos,
    algorithmsRoot: artifacts.algorithms,
  })
  if (!resolved.found) throw new Error("algorithm folder unresolved")
  return path.join(resolved.path, "reviews", input.experimentId)
}

export async function writeFileAtomically(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, "utf8")
    await fs.rename(temporary, file)
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

function reviewManifest(input: FinalReviewInput, data: QuantReviewData, manifests: BacktestStore.Manifest[]) {
  return {
    schema: "finny.quant-review",
    version: 1,
    algorithmId: input.algorithm.algorithmId,
    experimentIds: data.specs.map((spec) => spec.experimentId),
    conclusion: input.conclusion,
    workflowQualification: input.qualification,
    generatedAt: data.generatedAt,
    runs: manifests.map((manifest) => manifest.id),
    versions: data.versions.map((version) => version.version),
  }
}

async function persistReview(input: FinalReviewInput, data: QuantReviewData, manifests: BacktestStore.Manifest[]) {
  const reviewDir = await reviewDirectory(input)
  await fs.mkdir(reviewDir, { recursive: true })
  const reviewPath = path.join(reviewDir, "review.html")
  const manifestPath = path.join(reviewDir, "manifest.json")
  await writeFileAtomically(reviewPath, renderQuantReviewHtml(data))
  await writeFileAtomically(manifestPath, `${JSON.stringify(reviewManifest(input, data, manifests), null, 2)}\n`)
  return { reviewPath, reviewDir }
}

export async function generateFinalQuantReview(input: FinalReviewInput) {
  if (!/^[a-zA-Z0-9._-]{8,120}$/.test(input.experimentId)) throw new Error("invalid experimentId")
  const specs = await lineage(input.experimentId)
  const { data, manifests } = await reviewData(input, specs)
  const terminalErrors = validateTerminalReview({ ...data, algorithmId: input.algorithm.algorithmId })
  if (terminalErrors.length) throw new Error(`final review refused: ${terminalErrors.join("; ")}`)
  return { ...(await persistReview(input, data, manifests)), data }
}
