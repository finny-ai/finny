import z from "zod"
import crypto from "node:crypto"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"
import { Validate } from "../algorithm/validate"
import { evaluateBacktestQuality } from "../backtest/evaluation"
import { composeBacktestVerdict, deriveWalkForwardVerdict } from "../backtest/verdict"
import { generateReviewPacket } from "../backtest/review-packet"
import { CRUCIBLE_2_0_PRODUCT_LABEL, representativeRerunForAlgorithm } from "../backtest/crucible-reruns"
import { requireVerifiedDataExtractorEvidenceForSession } from "../data/data-extractor-evidence"
import {
  analyzeStrategyCodePatterns,
  classifyCompletedBacktestFailure,
  classifyDataBlockedFailure,
  classifyEngineFailedFailure,
  classifyValidationFailedFailure,
  formatFailureDiagnosisBlock,
  zeroTradeLikelyCause,
  type FailureDiagnosis,
} from "./backtest-failure-diagnosis"
import fs from "node:fs/promises"
import path from "node:path"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import {
  approvalScopeHash,
  makeApprovalChallenge,
  paperTradingApprovalScope,
} from "@/algorithm/build-workflow/state"
import {
  experimentAttemptForRun,
  type ExperimentRunContext,
} from "@/algorithm/build-workflow/experiment"
import type { ApprovalKind, ApprovalScope, BuildWorkflowState } from "@/algorithm/build-workflow/types"
import {
  completeWorkflowBacktest,
  ensureWorkflowCandidate,
  failActiveWorkflowBacktest,
  failWorkflowBacktest,
  pendingEvidenceRequirements,
  recordVerifiedMarketData,
  recordWorkflowAttempt,
  startWorkflowBacktest,
} from "@/algorithm/build-workflow/lifecycle"
import { beginTrial, completeTrial, ExperimentContractError, type ExperimentInput } from "../backtest/experiment"
import { qualificationInputForResearch } from "../backtest/qualification-policy"
import { readRequestSpecForSession } from "@/agent/request-spec"

export function backtestAttemptFingerprint(input: {
  params: unknown
  requestVersion?: number
  evidence?: { manifestSha256: string; csvSha256: string }
  candidate?: { algorithmId: string; version: number; code: string; config?: string }
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      params: input.params,
      requestVersion: input.requestVersion ?? null,
      evidence: input.evidence
        ? `${input.evidence.manifestSha256}:${input.evidence.csvSha256}`
        : "provider_fetch_research_only",
      candidate: input.candidate
        ? {
            algorithmId: input.candidate.algorithmId,
            version: input.candidate.version,
            codeSha256: crypto.createHash("sha256").update(input.candidate.code).digest("hex"),
            configSha256: crypto.createHash("sha256").update(input.candidate.config ?? "").digest("hex"),
          }
        : null,
    }))
    .digest("hex")
}

export function experimentInputForBacktest(input: {
  provided?: ExperimentInput
  dataSourceKind: BacktestRunner.BacktestDataSource["kind"]
  sessionId: string
  fingerprint: string
}): ExperimentInput | undefined {
  if (input.provided) return input.provided
  if (input.dataSourceKind === "verified_artifact") return undefined
  // Provider-fetched runs are exploratory and may observe revised upstream
  // candles or a different provider than an older run of the same algorithm.
  // Keep their snapshot contract request-scoped so unrelated experiments do
  // not block the research backtest.
  return {
    experimentId: `exp-research-${crypto
      .createHash("sha256")
      .update(`${input.sessionId}:${input.fingerprint}`)
      .digest("hex")
      .slice(0, 24)}`,
  }
}

export function resolveBoundBacktestDates(input: {
  params: { startDate?: string; endDate?: string }
  workflowWindow?: { start: string; end: string }
  requestSpecWindow?: { start?: string; end?: string }
}) {
  return {
    startDate: input.workflowWindow?.start ?? input.requestSpecWindow?.start ?? input.params.startDate,
    endDate: input.workflowWindow?.end ?? input.requestSpecWindow?.end ?? input.params.endDate,
  }
}

export function authoritativeBacktestInputIssue(input: {
  params: { startDate?: string; endDate?: string; interval?: string }
  workflowWindow?: { start: string; end: string }
  workflowInterval?: string
}): string | undefined {
  if (input.workflowWindow) {
    if (input.params.startDate && input.params.startDate !== input.workflowWindow.start) {
      return `startDate ${input.params.startDate} conflicts with confirmed workflow start ${input.workflowWindow.start}`
    }
    if (input.params.endDate && input.params.endDate !== input.workflowWindow.end) {
      return `endDate ${input.params.endDate} conflicts with confirmed workflow end ${input.workflowWindow.end}`
    }
  }
  if (input.workflowInterval && input.params.interval && input.params.interval !== input.workflowInterval) {
    return `interval ${input.params.interval} conflicts with confirmed workflow interval ${input.workflowInterval}`
  }
  return undefined
}

type WfMeta = {
  n_folds: number
  is_sharpe_mean: number
  oos_sharpe_mean: number
  oos_decay: number | null
  is_to_oos_sharpe_change?: number
  flag_threshold: number
  flagged: boolean
  deflated_sharpe: number | null
  probabilistic_sharpe: number | null
  stitched_oos_return?: number
  stitched_oos_sharpe?: number
  stitched_oos_trades?: number
  stitched_oos_bars?: number
  stitched_oos_coverage?: number
  ruined_folds?: number
  multiple_testing_trials?: number
  flag_reasons?: string[]
  folds: Array<{
    fold: number
    train_start: string
    train_end: string
    test_start: string
    test_end: string
    is_sharpe: number | null
    oos_sharpe: number | null
    is_return: number
    oos_return: number
    oos_trades?: number
    oos_coverage?: number
    ruined?: boolean
  }>
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "N/A"
}

export function formatWalkForwardLines(input: {
  algorithmName: string
  version: number
  duration: string
  start: string
  end: string
  walkForward: WfMeta
  benchmarkReturn?: number
  alpha?: number
  verdict: string
  verdictReason: string
}): string[] {
  const walkForward = input.walkForward
  const robustnessRatio = Number.isFinite(walkForward.is_sharpe_mean) && walkForward.is_sharpe_mean > 0 && Number.isFinite(walkForward.oos_sharpe_mean)
    ? walkForward.oos_sharpe_mean / walkForward.is_sharpe_mean
    : null
  return [
    `Algorithm: ${input.algorithmName} (v${input.version})`,
    `Total window: ${input.duration} (${input.start} -> ${input.end})`,
    `Rolling out-of-sample folds: ${walkForward.n_folds}`,
    ``,
    `IS Sharpe mean:        ${fmtNum(walkForward.is_sharpe_mean)}`,
    `OOS Sharpe mean:       ${fmtNum(walkForward.oos_sharpe_mean)}`,
    `IS->OOS Sharpe change: ${fmtNum(walkForward.is_to_oos_sharpe_change ?? (walkForward.oos_sharpe_mean - walkForward.is_sharpe_mean))}`,
    `Robustness ratio:      ${fmtNum(robustnessRatio)}`,
    `Stitched OOS return:   ${fmtNum((walkForward.stitched_oos_return ?? 0) * 100)}%`,
    input.benchmarkReturn === undefined ? null : `Buy-hold return:       ${fmtNum(input.benchmarkReturn * 100)}%`,
    input.alpha === undefined ? null : `Alpha vs buy-hold:     ${fmtNum(input.alpha * 100)} pts`,
    `Stitched OOS Sharpe:   ${fmtNum(walkForward.stitched_oos_sharpe ?? walkForward.oos_sharpe_mean)}`,
    `Stitched OOS trades:   ${walkForward.stitched_oos_trades ?? "N/A"}`,
    `OOS coverage:          ${fmtNum((walkForward.stitched_oos_coverage ?? 0) * 100)}%`,
    `Ruined folds:          ${walkForward.ruined_folds ?? 0}`,
    `Multiple-test trials:  ${walkForward.multiple_testing_trials ?? 1}`,
    `Deflated Sharpe prob:  ${fmtNum(walkForward.deflated_sharpe, 3)}`,
    `Prob. Sharpe ratio:    ${fmtNum(walkForward.probabilistic_sharpe, 3)}`,
    ``,
    `fold\ttrain\ttest\tIS Sharpe\tOOS Sharpe\tOOS Return\tOOS Trades\tCoverage\tRuined`,
    ...walkForward.folds.map(f =>
      `${f.fold}\t${f.train_start.slice(0, 10)}->${f.train_end.slice(0, 10)}\t${f.test_start.slice(0, 10)}->${f.test_end.slice(0, 10)}\t${fmtNum(f.is_sharpe)}\t${fmtNum(f.oos_sharpe)}\t${(f.oos_return * 100).toFixed(2)}%\t${f.oos_trades ?? "N/A"}\t${fmtNum((f.oos_coverage ?? 0) * 100)}%\t${f.ruined ? "yes" : "no"}`,
    ),
    ``,
    `Verdict: ${input.verdict.toUpperCase()} - ${input.verdictReason}`,
  ].filter((line): line is string => line !== null)
}

const experimentParameters = z.object({
  experimentId: z.string().optional().describe("Advanced only: reuse an existing persisted experiment ID or create an explicit named root. Never invent an ID for an ordinary run."),
  parentExperimentId: z.string().optional().describe("Advanced lineage only: pass an ID confirmed to exist in the experiment store. Never invent or self-reference a parent."),
  hypothesis: z.string().optional(),
  falsificationCriteria: z.string().optional(),
  dataSnapshot: z.string().optional().describe("Deprecated input. Omit it; runtime binds the actual engine data hash after the first completed run."),
  corporateActionPolicy: z.string().optional(),
  costs: z.string().optional(), featureTiming: z.string().optional(), executionSemantics: z.string().optional(),
  permittedSearchSpace: z.string().optional(), optimizationBudget: z.number().int().positive().max(10000).optional(),
  primaryMetric: z.string().optional(), riskConstraints: z.string().optional(), benchmark: z.string().optional(),
  qualityGates: z.object({ minDeflatedSharpe: z.number().min(0).max(1).optional(), minProbabilisticSharpe: z.number().min(0).max(1).optional(), minOosCoverage: z.number().min(0).max(1).optional(), minTrades: z.number().int().positive().optional(), requireCostSensitivity: z.boolean().optional() }).optional(),
})

const parameters = z.object({
  algorithmName: z
    .string()
    .describe("Name of the saved algorithm to backtest (e.g. 'uco-intraday-hybrid')"),
  duration: z
    .string()
    .regex(/^\d+[dwmy]$/i, "Duration must match <number><unit> where unit is d/w/m/y (e.g. '5d', '2w', '1m', '1y')")
    .default("6m")
    .describe(
      "Backtest period as <number><unit> where unit is d (days), w (weeks), m (months), or y (years). " +
        "Examples: '5d' = 5 days, '2w' = 2 weeks, '6m' = 6 months, '1y' = 1 year. 6m+ is recommended; shorter windows produce insufficient-history durability labels.",
    ),
  interval: z
    .enum(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
    .default("1h")
    .describe("Bar interval. Should match the algorithm's designed interval."),
  capital: z
    .string()
    .default("10000")
    .describe("Starting capital in USD (e.g. '10000')"),
  walkForwardFolds: z
    .number()
    .int()
    .min(2)
    .default(10)
    .describe("Number of rolling walk-forward folds to run. Defaults to 10; use any integer of at least 2."),
  feeBps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Optional taker fee in basis points for this run. Overrides the saved execution fee without changing the algorithm."),
  slippageBps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Optional base slippage in basis points for this run. Overrides the saved execution slippage without changing the algorithm."),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
    .optional()
    .describe("Exact backtest start date YYYY-MM-DD. Required when the user requested explicit dates."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
    .optional()
    .describe("Exact backtest end date YYYY-MM-DD. Required when the user requested explicit dates."),
  dataQualityMode: z
    .enum(["strict", "repair_outliers"])
    .default("strict")
    .describe("Strict by default. repair_outliers requires an exact controller-backed workflow approval."),
  repairOutliersApproved: z
    .boolean()
    .optional()
    .describe(
      "Deprecated compatibility hint. It never grants repair approval; a scoped workflow approval record is required.",
    ),
  userApproved: z
    .boolean()
    .optional()
    .describe("Deprecated compatibility hint. It does not grant any workflow approval."),
  experiment: experimentParameters.optional().describe("Optional advanced scientific lineage. OMIT this entire object for ordinary autonomous backtests; runtime derives a safe root experiment and owns the data snapshot. Never invent experimentId, parentExperimentId, or dataSnapshot."),
})

type BacktestToolMetadata = { [key: string]: unknown }

export type DataQualityFailureMetadata = {
  kind: "data_quality_failed"
  algorithmName: string
  params: {
    duration: string
    interval: string
    capital: string
    startDate?: string
    endDate?: string
    dataQualityMode: "strict" | "repair_outliers"
  }
  phase?: "before_resample" | "after_resample"
  reason: string
  symbol?: string
  provider?: string
  interval?: string
  rawRows?: number
  postRows?: number
  coverage?: number
  gaps?: number
  duplicates?: number
  invalidOhlc?: number
  outliers?: number
  zeroVolume?: number
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

export function repairOutliersBlockMessage(input: {
  dataQualityMode: "strict" | "repair_outliers"
  repairOutliersApproved?: boolean
}) {
  if (input.dataQualityMode !== "repair_outliers") return undefined
  return (
    "Backtest blocked: repair_outliers mode requires a scoped workflow approval record for a research-only repaired-data rerun. " +
    "The deprecated repairOutliersApproved boolean cannot grant approval.\n\n" +
    "Run strict mode first. If strict data quality fails, stop and report the exact timestamp(s) and reason; do not repair automatically."
  )
}

export function paperApprovalRequestForWorkflow(
  state: Pick<BuildWorkflowState, "stage" | "backtest"> | undefined,
) {
  if (
    state?.stage !== "reviewable" ||
    state.backtest?.verdict !== "recommended_for_paper"
  ) {
    return undefined
  }
  return {
    kind: "paper_trading" as const,
    scope: paperTradingApprovalScope(state.backtest),
    reason: "Approve this exact hash-complete reviewed run for paper trading.",
  }
}

export function strictDataQualityNextSteps() {
  return [
    "No performance metrics were produced; do not call this strategy backtested, ready, or paper/live eligible.",
    "Valid next steps:",
    "1. Verify the flagged candles first: inspect neighboring raw candles and compare another provider if available.",
    "2. Keep the confirmed window/interval. Do not shrink duration or switch bars to chase strict_qualified.",
    "3. Ask the user before changing the backtest window, interval, provider, or data-quality strictness.",
    "4. Only after explicit user approval, run repair_outliers as a research-only rerun on the same confirmed identity.",
    "5. research_only verified evidence is a valid research path — present research metrics; do not thrash identity.",
  ].join("\n")
}

function stringDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

export function inferSavedBacktestDates(configText: string | undefined) {
  if (!configText?.trim()) return {}
  try {
    const config = JSON.parse(configText)
    const candidates = [
      config?.backtest,
      config?.backtest_window,
      config?.data,
      config?.evidence,
      config?.params,
    ]
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue
      const startDate =
        stringDate(candidate.startDate) ??
        stringDate(candidate.start_date) ??
        stringDate(candidate.start) ??
        stringDate(candidate.requested_start)
      const endDate =
        stringDate(candidate.endDate) ??
        stringDate(candidate.end_date) ??
        stringDate(candidate.end) ??
        stringDate(candidate.requested_end)
      if (startDate && endDate) return { startDate, endDate }
    }
  } catch {}
  return {}
}

export { zeroTradeLikelyCause } from "./backtest-failure-diagnosis"
export type { FailureDiagnosis } from "./backtest-failure-diagnosis"

function parseNumberField(text: string, field: string) {
  const match = text.match(new RegExp(`${field}=(-?\\d+(?:\\.\\d+)?)`))
  return match ? Number(match[1]) : undefined
}

function parseStringField(text: string, field: string) {
  const match = text.match(new RegExp(`${field}=([^,\\s)]+)`))
  return match?.[1]
}

export function parseDataQualityFailure(
  error: string,
  input: {
    algorithmName: string
    duration: string
    interval: string
    capital: string
    startDate?: string
    endDate?: string
    dataQualityMode: "strict" | "repair_outliers"
  },
): DataQualityFailureMetadata | undefined {
  if (!error.includes("__FINNY_OUTLIER__") && !error.includes("Data quality failed")) return undefined

  const phase = error.includes("Data quality failed before resample")
    ? "before_resample"
    : error.includes("Data quality failed after resample")
      ? "after_resample"
      : undefined
  const reason =
    error
      .split(/\r?\n/)
      .find((line) => line.includes("Data quality failed"))
      ?.trim() ?? "Strict data quality failed."

  const outlierDetails = [...error.matchAll(/__FINNY_OUTLIER__:\s+ts=(.*?)\s+prev_close=([^\s]+)\s+close=([^\s]+)\s+log_return=([^\s]+)\s+z=([^\s]+)\s+provider=([^\s]+)/g)].map(
    (match) => ({
      timestamp: match[1],
      prev_close: Number(match[2]),
      close: Number(match[3]),
      log_return: Number(match[4]),
      z_score: Number(match[5]),
      provider: match[6],
    }),
  )

  const reportLine = error
    .split(/\r?\n/)
    .find((line) => line.includes("provider=") && line.includes("symbol=") && line.includes("interval="))

  const provider = parseStringField(reportLine ?? "", "provider") ?? outlierDetails[0]?.provider

  return {
    kind: "data_quality_failed",
    algorithmName: input.algorithmName,
    params: input,
    phase,
    reason,
    symbol: parseStringField(reportLine ?? "", "symbol"),
    provider,
    interval: parseStringField(reportLine ?? "", "interval") ?? input.interval,
    rawRows: parseNumberField(reportLine ?? "", "raw_rows"),
    postRows: parseNumberField(reportLine ?? "", "post_rows"),
    coverage: parseNumberField(reportLine ?? "", "coverage"),
    gaps: parseNumberField(reportLine ?? "", "gaps"),
    duplicates: parseNumberField(reportLine ?? "", "duplicates"),
    invalidOhlc: parseNumberField(reportLine ?? "", "invalid_ohlc"),
    outliers: parseNumberField(reportLine ?? "", "outliers"),
    zeroVolume: parseNumberField(reportLine ?? "", "zero_volume"),
    repair_outliers_allowed: input.dataQualityMode === "repair_outliers",
    outlierDetails,
  }
}

async function verifyPersistedRecommendation(input: {
  artifactDir?: string
  unifiedVerdict: string
  verdictReasons: string[]
}) {
  if (!input.artifactDir) return
  const file = path.join(input.artifactDir, "run.json")
  const raw = JSON.parse(await fs.readFile(file, "utf8"))
  const persisted = raw?.recommendation
  if (persisted?.verdict !== input.unifiedVerdict) {
    throw new Error(`immutable run recommendation mismatch: persisted=${persisted?.verdict ?? "missing"}, computed=${input.unifiedVerdict}`)
  }
  if (JSON.stringify(persisted?.reasons ?? []) !== JSON.stringify(input.verdictReasons)) {
    throw new Error("immutable run recommendation reasons do not match the computed verdict")
  }
}

export const BacktestTool = Tool.define<typeof parameters, BacktestToolMetadata, Database.Service, "finny_backtest">(
  "finny_backtest",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runWorkflow = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      Effect.runPromise(Effect.provideService(effect, Database.Service, database))

    return {
    description:
      "Run the full research-only backtest gauntlet on a saved algorithm in one call: base backtest, walk-forward, Monte Carlo, regimes, consistency, alpha decay, deterministic verdict, and durability baseline. Verified evidence is optional for this exploratory operation: call it directly without launching evidence agents solely to unlock a backtest. Provider-fetched results remain research-only. A recommended research result may create a controller-scoped paper-approval challenge, but this operation cannot qualify a candidate or create a promotable run. For qualification, call qualify_candidate(candidateId, experimentPlanId); runtime code then owns every legal phase window and transition.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const preflightWorkflow = (yield* Effect.promise(() =>
          runWorkflow(BuildWorkflowStore.listBySession(ctx.sessionID)),
        )).find((item) => item.status === "active" || item.status === "blocked")
        const requestSpec = yield* Effect.promise(() => readRequestSpecForSession({ sessionID: ctx.sessionID }))
        const authoritativeIssue = authoritativeBacktestInputIssue({
          params,
          workflowWindow: preflightWorkflow?.identity.window?.value,
          workflowInterval: preflightWorkflow?.identity.interval?.value,
        })
        if (authoritativeIssue) {
          return {
            title: "Backtest blocked by confirmed request",
            output: `BLOCKED: ${authoritativeIssue}. Use the confirmed WorkflowRun inputs; amend the request through the controller instead of shifting the evaluation scope.`,
            metadata: { algorithmName: undefined, params: undefined, results: undefined },
          }
        }
        const boundDates = resolveBoundBacktestDates({
          params,
          workflowWindow: preflightWorkflow?.identity.window?.value,
          requestSpecWindow: { start: requestSpec?.requested_start, end: requestSpec?.requested_end },
        })
        const boundStartDate = boundDates.startDate
        const boundEndDate = boundDates.endDate
        const evidence = yield* Effect.promise(() => requireVerifiedDataExtractorEvidenceForSession(ctx.sessionID))
        const dataSource: BacktestRunner.BacktestDataSource = evidence.ok
          ? { kind: "verified_artifact", dataset: evidence.dataset }
          : { kind: "provider_fetch" }
        const algo = yield* Effect.promise(() => Algorithm.get(params.algorithmName))
        if (!algo) {
          return {
            title: "Backtest failed",
            output: `Algorithm "${params.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
            metadata: { algorithmName: undefined, params: undefined, results: undefined },
          }
        }
        const fingerprint = backtestAttemptFingerprint({
          params: { ...params, startDate: boundStartDate, endDate: boundEndDate },
          requestVersion: preflightWorkflow?.requestVersion,
          evidence: evidence.ok ? evidence.dataset : undefined,
          candidate: {
            algorithmId: algo.algorithmId,
            version: algo.version,
            code: algo.code,
            config: algo.config,
          },
        })
        const durableStart = yield* Effect.promise(() =>
          runWorkflow(recordWorkflowAttempt({
            sessionId: ctx.sessionID,
            operation: "finny_backtest",
            fingerprint,
            idempotencyKey: `backtest:begin:${fingerprint}`,
            outcome: "accepted",
          })),
        )
        if (!durableStart.allowed) {
          return {
            title: "Backtest blocked by durable workflow",
            output: `BLOCKED: ${durableStart.message}`,
            metadata: {
              algorithmName: undefined,
              params: undefined,
              results: undefined,
              blocked: true,
              blockerCode: durableStart.code,
            },
          }
        }
        const resultExit = yield* Effect.exit(Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_backtest",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        let workflow = preflightWorkflow
        let experiment: ExperimentRunContext | undefined
        let paperApprovalChallengeId: string | undefined

        const exactApproval = (state: BuildWorkflowState | undefined, kind: ApprovalKind, scope: ApprovalScope) => {
          if (!state) return false
          const hash = approvalScopeHash(kind, scope)
          return state.approvals.some((record) => record.kind === kind && record.scopeHash === hash)
        }

        const ensureChallenge = async (kind: ApprovalKind, scope: ApprovalScope, reason: string) => {
          if (!workflow) return undefined
          const scopeHash = approvalScopeHash(kind, scope)
          const existing = workflow.approvalChallenges.find(
            (item) => item.kind === kind && item.scopeHash === scopeHash && item.status === "pending",
          )
          if (existing) return existing.id
          const challenge = makeApprovalChallenge({
            id: `approval_${crypto.randomUUID()}`,
            kind,
            scope,
            reason,
          })
          const result = await runWorkflow(
            BuildWorkflowStore.append({
              workflowId: workflow.workflowId,
              expectedRevision: workflow.revision,
              event: {
                id: `evt_${crypto.randomUUID()}`,
                type: "approval.requested",
                occurredAt: challenge.createdAt,
                source: { actor: "tool" },
                challenge,
              },
            }),
          )
          if (result.kind === "applied") {
            workflow = result.decision.state
            return challenge.id
          }
          return undefined
        }

        const recordExperiment = async (outcome: "metrics" | "setup_failure" | "engine_failure", runId?: string) => {
          if (!experiment) return undefined
          const result = await runWorkflow(
            BuildWorkflowStore.append({
              workflowId: experiment.workflow.workflowId,
              event: {
                id: `evt_experiment_${crypto.randomUUID()}`,
                type: "experiment.recorded",
                occurredAt: Date.now(),
                source: { actor: "tool" },
                attempt: experimentAttemptForRun({
                  context: experiment,
                  id: `attempt_${crypto.randomUUID()}`,
                  outcome,
                  runId,
                }),
              },
            }),
          )
          if (result.kind === "applied") workflow = result.decision.state
          return result
        }

        const emptyMeta = {
          algorithmName: undefined as string | undefined,
          params: undefined as { duration: string; interval: string; capital: string } | undefined,
          results: undefined as BacktestRunner.Results | undefined,
        }

        const repairScope: ApprovalScope = {
          algorithmName: params.algorithmName,
          dataQualityMode: "repair_outliers",
        }
        // Research-only verified evidence already encodes non-promotable quality
        // caveats (commonly isolated outliers). Allow the research repair path
        // without a second approval so the confirmed window can be evaluated.
        const researchOnlyVerified =
          evidence.ok && evidence.dataset.identity.qualification === "research_only"
        if (
          params.dataQualityMode === "repair_outliers" &&
          !researchOnlyVerified &&
          !exactApproval(workflow, "repair_outliers", repairScope)
        ) {
          const challengeId = await ensureChallenge(
            "repair_outliers",
            repairScope,
            "Approve a research-only rerun that repairs isolated market-data outliers.",
          )
          return {
            title: "Backtest blocked by repair approval",
            output:
              "Backtest blocked: repair_outliers mode requires a scoped workflow approval record. " +
              "The deprecated repairOutliersApproved boolean cannot grant approval." +
              (challengeId
                ? ` Call finny_workflow_request_approval with challengeId=${challengeId}.`
                : " No authoritative workflow challenge is available in this legacy session."),
            metadata: { ...emptyMeta, repair_outliers_allowed: false, approvalChallengeId: challengeId },
          }
        }

        if (evidence.ok) {
          const evidencedWorkflow = await runWorkflow(
            recordVerifiedMarketData({ sessionId: ctx.sessionID, dataset: evidence.dataset }),
          )
          if (evidencedWorkflow) workflow = evidencedWorkflow
        }
        const pendingEvidence = workflow ? pendingEvidenceRequirements(workflow) : []

        const assetClass = typeof (algo.config as any)?.asset_class === "string" ? (algo.config as any).asset_class : undefined
        const codePatternWarnings = analyzeStrategyCodePatterns(algo.code, {
          assetClass,
          interval: params.interval,
        })

        let riskBanner = ""
        try {
          const v = await Validate.run(algo.code, {
            config: algo.config,
          })
          if (!v.valid) {
            const failureDiagnosis = classifyValidationFailedFailure()
            return {
              title: "Backtest blocked by validation",
              output: `${Validate.format(v)}${formatFailureDiagnosisBlock(failureDiagnosis).join("\n")}`,
              metadata: { ...emptyMeta, failure_diagnosis: failureDiagnosis },
            }
          }
          riskBanner = Validate.formatRiskBanner(v)
        } catch (e: any) {
          const failureDiagnosis = classifyValidationFailedFailure()
          return {
            title: "Backtest blocked by validation",
            output: `Validation failed to run: ${e?.message ?? String(e)}${formatFailureDiagnosisBlock(failureDiagnosis).join("\n")}`,
            metadata: { ...emptyMeta, failure_diagnosis: failureDiagnosis },
          }
        }

        if (codePatternWarnings.length > 0) {
          const preflight = [
            `[!] CODE PATTERN PREFLIGHT (${codePatternWarnings.length}) — review before interpreting zero-trade or sizing failures:`,
            ...codePatternWarnings.map((w) => `  • ${w}`),
          ].join("\n")
          riskBanner = riskBanner ? `${riskBanner}\n\n${preflight}` : preflight
        }

        const savedBacktestDates = inferSavedBacktestDates(algo.config)
        const effectiveStartDate = boundStartDate ?? savedBacktestDates.startDate
        const effectiveEndDate = boundEndDate ?? savedBacktestDates.endDate
        if (workflow && evidence.ok) {
          const candidate = await runWorkflow(ensureWorkflowCandidate({
            workflow,
            algorithm: algo,
            dataset: evidence.dataset,
            interval: params.interval,
            start: effectiveStartDate,
            end: effectiveEndDate,
          }))
          workflow = candidate.workflow
          experiment = candidate.experiment
        }
        const totalDays = BacktestRunner.parseDurationDays(params.duration)
        if (!totalDays || totalDays < 14) {
          const failureDiagnosis = classifyEngineFailedFailure("window too short for >=2 folds")
          return {
            title: "Backtest failed",
            output:
              `Backtest of "${params.algorithmName}" failed:\nDuration "${params.duration}" is too short for >=2 walk-forward folds. Use a longer duration or coarser interval.\nVerdict: failed` +
              formatFailureDiagnosisBlock(failureDiagnosis).join("\n"),
            metadata: { ...emptyMeta, failure_diagnosis: failureDiagnosis },
          }
        }
        let trial: Awaited<ReturnType<typeof beginTrial>>
        try {
          trial = await beginTrial({
            algorithm: algo,
            interval: params.interval,
            startDate: effectiveStartDate,
            endDate: effectiveEndDate,
            sessionId: ctx.sessionID,
            experiment: experimentInputForBacktest({
              provided: params.experiment as ExperimentInput | undefined,
              dataSourceKind: dataSource.kind,
              sessionId: ctx.sessionID,
              fingerprint,
            }),
          })
        } catch (error) {
          const message = error instanceof ExperimentContractError ? error.message : `experiment ledger unavailable: ${String(error)}`
          return { title: "Backtest blocked by experiment contract", output: `Backtest blocked: ${message}`, metadata: { ...emptyMeta, blocked: true, experimentContract: true } }
        }
        const finishTrial = (outcome: "passed" | "failed" | "blocked", details: string, result?: BacktestRunner.Results) => completeTrial({ reference: trial.reference, sessionId: ctx.sessionID, algorithm: algo, outcome, details, runId: result?.runId, actualDataHash: typeof result?.v2?.run_metadata?.data_hash === "string" ? result.v2.run_metadata.data_hash : undefined })
        if (workflow && experiment) {
          workflow = await runWorkflow(startWorkflowBacktest(workflow))
          experiment = { ...experiment, workflow }
        }
        const result = await BacktestRunner.run({
          algorithm: algo,
          duration: params.duration,
          interval: params.interval,
          capital: params.capital,
          startDate: effectiveStartDate,
          endDate: effectiveEndDate,
          dataQualityMode: params.dataQualityMode,
          configOverrides:
            params.feeBps === undefined && params.slippageBps === undefined
              ? undefined
              : {
                  execution: {
                    ...(params.feeBps === undefined ? {} : { taker_fee_bps: params.feeBps }),
                    ...(params.slippageBps === undefined ? {} : { slippage_bps: params.slippageBps }),
                  },
                },
          robustness: {
            monteCarloPaths: 500,
            regimes: true,
            walkForwardFolds: params.walkForwardFolds,
            priorSelectionTrials: experiment?.trials.priorUniqueTrials ?? 0,
            currentSelectionTrials: experiment?.trials.currentGridTrials ?? 1,
          },
          experiment: trial.reference,
          sessionID: ctx.sessionID,
          dataSource,
        })

        if (!result.ok) {
          await finishTrial("failed", result.error)
          if (workflow?.stage === "backtest_running") {
            workflow = await runWorkflow(
              failWorkflowBacktest({ workflowId: workflow.workflowId, reason: result.error }),
            )
          }
          await recordExperiment("engine_failure")
          const dataQualityFailure = parseDataQualityFailure(result.error, {
            algorithmName: params.algorithmName,
            duration: params.duration,
            interval: params.interval,
            capital: params.capital,
            startDate: effectiveStartDate,
            endDate: effectiveEndDate,
            dataQualityMode: params.dataQualityMode,
          })
          if (dataQualityFailure) {
            const failureDiagnosis = classifyDataBlockedFailure(dataQualityFailure.reason)
            const details = dataQualityFailure.outlierDetails
              .map(
                (d) =>
                  `outlier ts=${d.timestamp} prev_close=${d.prev_close} close=${d.close} log_return=${d.log_return} z=${d.z_score} provider=${d.provider ?? dataQualityFailure.provider ?? "unknown"}`,
              )
              .join("\n")
            return {
              title: "Backtest blocked by data quality",
              output:
                `Strict data quality blocked "${params.algorithmName}".\n` +
                `${dataQualityFailure.reason}\n` +
                (details ? `\n${details}\n` : "") +
                `\nStopped without running repair_outliers.\nVerdict: failed\n\n${strictDataQualityNextSteps()}` +
                formatFailureDiagnosisBlock(failureDiagnosis).join("\n"),
              metadata: {
                ...emptyMeta,
                ...dataQualityFailure,
                failure_diagnosis: failureDiagnosis,
              },
            }
          }
          const failureDiagnosis = classifyEngineFailedFailure(result.error)
          return {
            title: "Backtest failed",
            output:
              `Backtest of "${params.algorithmName}" failed:\n${result.error}` +
              `\nVerdict: failed` +
              formatFailureDiagnosisBlock(failureDiagnosis).join("\n"),
            metadata: { ...emptyMeta, failure_diagnosis: failureDiagnosis },
          }
        }

        const r = result.results
        const ledgerResult = await recordExperiment("metrics", r.runId)
        if (ledgerResult?.kind === "rejected") {
          if (workflow?.stage === "backtest_running") {
            workflow = await runWorkflow(
              failWorkflowBacktest({
                workflowId: workflow.workflowId,
                reason: `experiment ledger rejected result: ${ledgerResult.decision.code}`,
              }),
            )
          }
          return {
            title: "Backtest completed but experiment ledger rejected it",
            output:
              `The engine completed, but the authoritative experiment ledger rejected the result (${ledgerResult.decision.code}). ` +
              "The run cannot establish eligibility or reset the selection budget.",
            metadata: {
              ...emptyMeta,
              results: { ...r, v2: undefined },
              experiment: experiment?.trials,
              ledgerTransitionCode: ledgerResult.decision.code,
            },
          }
        }
        const walkForward = r.v2?.walk_forward
        if (!walkForward || walkForward.n_folds < 2) {
          await finishTrial("failed", "strict engine produced fewer than two walk-forward folds", r)
          if (workflow?.stage === "backtest_running") {
            workflow = await runWorkflow(
              failWorkflowBacktest({
                workflowId: workflow.workflowId,
                reason: "strict engine did not produce enough walk-forward folds",
              }),
            )
          }
          const failureDiagnosis = classifyEngineFailedFailure("not enough walk-forward folds")
          return {
            title: "Backtest failed",
            output:
              `Backtest of "${params.algorithmName}" failed:\nStrict engine did not produce enough walk-forward folds. Use a longer duration or coarser interval.\nVerdict: failed` +
              formatFailureDiagnosisBlock(failureDiagnosis).join("\n"),
            metadata: { ...emptyMeta, failure_diagnosis: failureDiagnosis },
          }
        }
        const representativeRerun = representativeRerunForAlgorithm(algo.name)
        const qualification = qualificationInputForResearch({
          dataQualityMode: params.dataQualityMode,
          phase: trial.reference.phase,
        })
        const quality = evaluateBacktestQuality(r, qualification)
        const walkForwardVerdict = deriveWalkForwardVerdict(walkForward)
        const computedUnified = composeBacktestVerdict({
          quality,
          walkForward: walkForwardVerdict,
          consistency: r.v2?.consistency,
          decay: r.v2?.alpha_decay,
        })
        const researchOnlyArtifact =
          dataSource.kind === "verified_artifact" &&
          dataSource.dataset.identity.qualification === "research_only"
        const unified =
          computedUnified.verdict !== "failed" &&
          (dataSource.kind === "provider_fetch" || researchOnlyArtifact)
            ? {
                verdict: "research_only" as const,
                reasons: [
                  ...computedUnified.reasons,
                  ...(dataSource.kind === "provider_fetch"
                    ? ["provider_fetch_research_only"]
                    : ["verified_dataset_research_only"]),
                ],
              }
            : computedUnified
        await finishTrial(quality.label === "failed" ? "failed" : "passed", quality.label, r)
        if (workflow && experiment) {
          const controllerVerdict =
            unified.verdict === "recommended_for_paper" ||
            unified.verdict === "candidate" ||
            unified.verdict === "failed"
              ? unified.verdict
              : "research_only"
          workflow = await runWorkflow(
            completeWorkflowBacktest({
              workflow,
              experiment,
              results: r,
              verdict: controllerVerdict,
            }),
          )
          experiment = { ...experiment, workflow }
          const paperApproval = paperApprovalRequestForWorkflow(workflow)
          if (paperApproval) {
            paperApprovalChallengeId = await ensureChallenge(
              paperApproval.kind,
              paperApproval.scope,
              paperApproval.reason,
            )
            if (workflow) experiment = { ...experiment, workflow }
          }
        }
        await verifyPersistedRecommendation({
          artifactDir: r.artifactDir,
          unifiedVerdict: computedUnified.verdict,
          verdictReasons: computedUnified.reasons,
        })
        const reviewPacket = await generateReviewPacket({
          algorithm: algo,
          results: r,
          verdict: computedUnified.verdict,
          reasons: computedUnified.reasons,
        })
        const fmt = (v: number | null | undefined, d = 2) => v == null ? "N/A" : v.toFixed(d)
        const fmtPct = (v: number) => `${(v * 100).toFixed(2)}%`
        const fmtDollar = (v: number | null | undefined) => v == null ? "N/A" : `$${fmt(v)}`
        const processedRange = r.v2?.start_ts && r.v2?.end_ts ? `${r.v2.start_ts} → ${r.v2.end_ts}` : undefined

        const lines = [
          `Algorithm: ${algo.name} (v${algo.version})`,
          `Run surface: ${r.productLabel ?? (r.runKind === "legacy" ? "Legacy backtest" : CRUCIBLE_2_0_PRODUCT_LABEL)}`,
          `Duration: ${params.duration}` +
            (effectiveStartDate && effectiveEndDate ? ` (${effectiveStartDate} → ${effectiveEndDate})` : "") +
            ` | Interval: ${params.interval} | Capital: $${params.capital}`,
          evidence.ok
            ? `Data source: verified data_extractor artifact (strict qualification eligible)`
            : `Data source: provider fetch (research-only; evidence is optional, qualification/promotion disabled)`,
          !evidence.ok && pendingEvidence.length > 0
            ? `Optional evidence caveat: ${pendingEvidence.join(" | ")}`
            : null,
          processedRange ? `Processed range: ${processedRange} | Bars processed: ${r.diagnostics?.barsProcessed ?? r.v2?.bars_processed ?? "N/A"}` : null,
          params.dataQualityMode === "repair_outliers" ? `Data quality mode: REPAIRED DATA BACKTEST (research-only)` : `Data quality mode: strict`,
          ``,
          `┌──────────────────────────────────────────────────┐`,
          `│  BACKTEST RESULTS                                │`,
          `├──────────────────────┬───────────────────────────┤`,
          `│  Total Return        │  ${fmtPct(r.totalReturn).padStart(24)} │`,
          `│  Ending Equity       │  ${("$" + fmt(r.endingEquity)).padStart(24)} │`,
          `│  Max Drawdown        │  ${fmtPct(r.maxDrawdown).padStart(24)} │`,
          `│  Sharpe Ratio        │  ${fmt(r.sharpeRatio).padStart(24)} │`,
          `│  Total Trades        │  ${String(r.totalTrades).padStart(24)} │`,
          `│  Closed Trades       │  ${String(r.closedTrades ?? r.totalTrades).padStart(24)} │`,
          `│  Open Trades         │  ${String(r.openTradeCount ?? r.v2?.open_trades?.length ?? 0).padStart(24)} │`,
          `│  Realized PnL        │  ${fmtDollar(r.realizedPnl).padStart(24)} │`,
          `│  Unrealized PnL      │  ${fmtDollar(r.unrealizedPnl).padStart(24)} │`,
          `│  Win Rate            │  ${fmtPct(r.winRate).padStart(24)} │`,
          `│  Profit Factor       │  ${fmt(r.profitFactor).padStart(24)} │`,
          `│  Ann. Volatility     │  ${fmtPct(r.annualizedVolatility).padStart(24)} │`,
        ].filter((line): line is string => line !== null)

        if (r.navSummary || r.costAttribution) {
          lines.push(`├──────────────────────┼───────────────────────────┤`)
          if (r.navSummary) {
            lines.push(
              `│  MTM NAV             │  ${("$" + fmt(r.navSummary.mark_to_market_nav)).padStart(24)} │`,
              `│  Liquidation NAV     │  ${("$" + fmt(r.navSummary.liquidation_nav)).padStart(24)} │`,
            )
          }
          if (r.costAttribution) {
            lines.push(
              `│  Total Costs         │  ${("$" + fmt(r.costAttribution.total_costs)).padStart(24)} │`,
              `│  Costs / Start       │  ${fmtPct(r.costAttribution.cost_as_pct_starting_equity).padStart(24)} │`,
            )
          }
        }

        if (r.sortino !== undefined && r.totalTrades > 0) {
          lines.push(
            `├──────────────────────┼───────────────────────────┤`,
            `│  Sortino Ratio       │  ${fmt(r.sortino).padStart(24)} │`,
            `│  Calmar Ratio        │  ${fmt(r.calmar ?? 0).padStart(24)} │`,
            `│  VaR (95%)           │  ${fmtPct(r.var95 ?? 0).padStart(24)} │`,
            `│  CVaR (95%)          │  ${fmtPct(r.cvar95 ?? 0).padStart(24)} │`,
            `│  Max DD Duration     │  ${(String(r.maxDdDuration ?? 0) + " bars").padStart(24)} │`,
            `│  Time in Market      │  ${fmtPct(r.timeInMarket ?? 0).padStart(24)} │`,
          )
        }

        // Trade significance — surface t-stat, p-value, and dynamic low_sample
        const tradeBlock = r.v2?.trade
        if (tradeBlock && r.totalTrades > 0) {
          const tstat = tradeBlock.trade_tstat
          const pval = tradeBlock.trade_pvalue
          const barCount = r.diagnostics?.barsProcessed ?? r.v2?.bars_processed ?? 0
          const minTrades = Math.max(3, Math.min(30, Math.floor(barCount * 0.01)))
          const lowSample = r.totalTrades < minTrades
          lines.push(
            `├──────────────────────┼───────────────────────────┤`,
          )
          if (tstat != null) {
            lines.push(`│  Trade t-stat        │  ${fmt(tstat, 3).padStart(24)} │`)
          }
          if (pval != null) {
            const sig = pval < 0.01 ? "***" : pval < 0.05 ? "**" : pval < 0.10 ? "*" : ""
            lines.push(`│  Trade p-value       │  ${(fmt(pval, 4) + " " + sig).padStart(24)} │`)
          }
          if (lowSample) {
            lines.push(`│  Sample size         │  ${(`⚠ LOW (${r.totalTrades} trades)`).padStart(24)} │`)
          }
        }

        lines.push(`└──────────────────────┴───────────────────────────┘`)

        if (typeof r.benchmarkReturn === "number") {
          const symbol = r.v2?.symbols?.[0] ?? "asset"
          const alpha = typeof r.alpha === "number" ? r.alpha : r.totalReturn - r.benchmarkReturn
          const alphaLine =
            r.totalReturn < 0 && alpha > 0
              ? `Alpha vs buy-and-hold: ${fmtPct(alpha)} (defensive outperformance in a down window)`
              : `Alpha vs buy-and-hold: ${fmtPct(alpha)}`
          lines.push(
            ``,
            `── BENCHMARK ─────────────────────────────────────`,
            `Benchmark: buy-and-hold ${symbol}, same window`,
            `Return: ${fmtPct(r.benchmarkReturn)} | Max Drawdown: ${fmtPct(r.benchmarkMaxDrawdown ?? 0)} | Ending Equity: ${fmtDollar(r.benchmarkEndingEquity)}`,
            alphaLine,
          )
          if (typeof r.benchmarkSharpeRatio === "number") {
            lines.push(`Benchmark Sharpe: ${fmt(r.benchmarkSharpeRatio)}`)
          }
          if (r.v2?.benchmark) {
            const b = r.v2.benchmark as any
            lines.push(
              `Engine relative stats: alpha annualized ${fmtPct(r.v2.benchmark.alpha_annualized)} | information ratio ${fmt(r.v2.benchmark.information_ratio)} | beta ${fmt(b.beta)}`,
            )
          }
        } else if (r.v2?.benchmark) {
          const b = r.v2.benchmark as any
          lines.push(
            ``,
            `── BENCHMARK ─────────────────────────────────────`,
            `Benchmark: buy-and-hold ${r.v2.benchmark.benchmark_symbol}`,
            `Benchmark return: ${typeof b.benchmark_total_return === "number" ? fmtPct(b.benchmark_total_return) : "N/A"} | Strategy excess: ${typeof b.strategy_excess_return === "number" ? fmtPct(b.strategy_excess_return) : "N/A"}`,
            `Alpha annualized: ${fmtPct(r.v2.benchmark.alpha_annualized)} | Information ratio: ${fmt(r.v2.benchmark.information_ratio)}`,
          )
        } else if (r.v2?.run_metadata && typeof (r.v2.run_metadata as any).benchmark_unavailable_reason === "string") {
          lines.push(
            ``,
            `── BENCHMARK ─────────────────────────────────────`,
            `Benchmark unavailable: ${(r.v2.run_metadata as any).benchmark_unavailable_reason}`,
          )
        }

        lines.push(
          ``,
          `── QUALITY GATE ───────────────────────────────────`,
          `Verdict: ${quality.label}`,
        )
        if (r.totalReturn > 0 && !quality.paperEligible) {
          lines.push(quality.label === "inconclusive" ? `Positive MTM return, but result is inconclusive and NOT paper eligible.` : `Positive ROI, but NOT paper eligible.`)
        }
        if (quality.reasons.length > 0) {
          lines.push(`Reasons: ${quality.reasons.join("; ")}`)
        }
        if (r.totalTrades > 0 && r.totalTrades < quality.minTrades) {
          lines.push(
            `Closed trade count is below the minimum for this window (${r.totalTrades} < ${quality.minTrades}); do not treat Sharpe/win rate as statistically meaningful.`,
          )
        }
        if (r.v2?.data_quality) {
          const dq = r.v2.data_quality
          const notes = Array.isArray(dq.notes) && dq.notes.length ? ` Notes: ${dq.notes.slice(0, 3).join("; ")}` : ""
          lines.push(`Data quality: gaps=${dq.gap_count}, duplicates=${dq.duplicate_ts_count}, invalid_ohlc=${dq.ohlc_violations}, outliers=${dq.outlier_bars}.${notes}`)
        }
        if (r.v2?.data_quality?.repair_applied) {
          lines.push(`REPAIRED DATA BACKTEST — research-only until rerun on strict clean data.`)
        }
        if (r.eligibilityStatus && r.eligibilityStatus !== "paper_eligible" && r.eligibilityStatus !== "live_eligible") {
          lines.push(`Paper/live remains disabled until a Crucible 2.0 rerun reaches paper_eligible or live_eligible.`)
        }
        if (representativeRerun) {
          lines.push(`Representative rerun: ${representativeRerun.name} (${representativeRerun.gate}); attached to immutable v${algo.version}, no saved version replacement.`)
        }
        lines.push(`────────────────────────────────────────────────────`)

        lines.push(
          ``,
          `── WALK-FORWARD ───────────────────────────────────`,
          ...formatWalkForwardLines({
            algorithmName: algo.name,
            version: algo.version,
            duration: params.duration,
            start: effectiveStartDate ?? r.v2?.start_ts?.slice(0, 10) ?? "N/A",
            end: effectiveEndDate ?? r.v2?.end_ts?.slice(0, 10) ?? "N/A",
            walkForward,
            benchmarkReturn: r.benchmarkReturn,
            alpha: r.alpha,
            verdict: walkForwardVerdict.verdict,
            verdictReason: walkForwardVerdict.reason,
          }).slice(3),
          `────────────────────────────────────────────────────`,
        )

        const consistency = r.v2?.consistency
        lines.push(
          ``,
          `── CONSISTENCY ─────────────────────────────────────`,
          `Label: ${consistency?.label ?? "insufficient"} | Confidence: ${consistency?.confidence ?? "low"}`,
          `Equity R2: ${fmt(consistency?.equity_curve_r2, 3)} | K-ratio: ${fmt(consistency?.k_ratio, 3)} | Fold ICIR: ${fmt(consistency?.fold_icir, 3)}`,
          `Periods: ${consistency?.n_periods ?? 0} (${consistency?.period_rule ?? "insufficient"}) | Positive periods: ${consistency?.pct_positive_periods == null ? "N/A" : fmtPct(consistency.pct_positive_periods)}`,
          `Max losing-period streak: ${consistency?.max_consecutive_losing_periods ?? "N/A"} | Top-period return share: ${consistency?.top_period_return_share == null ? "N/A" : fmtPct(consistency.top_period_return_share)}`,
        )
        if (consistency?.reasons?.length) lines.push(`Reasons: ${consistency.reasons.join("; ")}`)
        lines.push(`────────────────────────────────────────────────────`)

        const decay = r.v2?.alpha_decay
        lines.push(
          ``,
          `── ALPHA DECAY ─────────────────────────────────────`,
          `Label: ${decay?.label ?? "insufficient"} | Confidence: ${decay?.confidence ?? "insufficient"}`,
          `Mann-Kendall: ${decay?.mann_kendall?.trend ?? "insufficient"} | p=${fmt(decay?.mann_kendall?.p_value, 4)} | n=${decay?.mann_kendall?.n ?? 0}`,
          `Fold slope: ${fmt(decay?.fold_slope?.slope, 3)} per fold | R2: ${fmt(decay?.fold_slope?.r_squared, 3)}`,
          `Cost breakeven: ${decay?.breakeven?.months == null ? decay?.breakeven?.status ?? "insufficient_history" : `${fmt(decay.breakeven.months, 1)} months`} | Per-trade cost: ${fmtDollar(decay?.breakeven?.per_trade_cost)}`,
        )
        if (decay?.reasons?.length) lines.push(`Reasons: ${decay.reasons.join("; ")}`)
        lines.push(`────────────────────────────────────────────────────`)

        lines.push(
          ``,
          `── UNIFIED VERDICT ─────────────────────────────────`,
          `Verdict: ${unified.verdict}` +
            (unified.verdict === "recommended_for_paper"
              ? paperApprovalChallengeId
                ? ` — awaiting user approval via finny_workflow_request_approval (challengeId=${paperApprovalChallengeId})`
                : " — controller approval challenge unavailable; promotion remains blocked"
              : ""),
          `Reasons: ${unified.reasons.join("; ")}`,
        )
        if (reviewPacket.reviewDir) lines.push(`Review packet: ${reviewPacket.reviewDir}/review.md and review.html`)
        if (reviewPacket.durabilityPath) lines.push(`Durability report: ${reviewPacket.durabilityPath}`)
        if (reviewPacket.error) lines.push(`Review packet warning: ${reviewPacket.error}`)
        lines.push(`────────────────────────────────────────────────────`)

        if (r.explanations || r.profileIdentity || (r.sensitivityOutcomes?.length ?? 0) > 0) {
          lines.push(``, `── CRUCIBLE 2.0 EXPLANATIONS ─────────────────────`)
          if (r.explanations) {
            lines.push(
              `Mark-to-market NAV: ${r.explanations.mark_to_market_nav}`,
              `Liquidation NAV: ${r.explanations.liquidation_nav}`,
              `Cost attribution: ${r.explanations.cost_attribution}`,
              `Profile identity: ${r.explanations.profile_identity}`,
              `Sensitivity outcomes: ${r.explanations.sensitivity_outcomes}`,
            )
          }
          if (r.profileIdentity) lines.push(`Profile ID: ${r.profileIdentity.profile_id}`)
          for (const outcome of r.sensitivityOutcomes ?? []) {
            lines.push(`Sensitivity: ${outcome.name}=${outcome.status}` + (outcome.value == null ? "" : ` (${fmt(outcome.value, 3)})`))
          }
          lines.push(`────────────────────────────────────────────────────`)
        }

        if (r.totalTrades === 0 && r.diagnostics) {
          const d = r.diagnostics
          lines.push(
            ``,
            `── ZERO-TRADE DIAGNOSTICS ──────────────────────────`,
            `Bars processed:  ${d.barsProcessed}`,
            `Buy attempts:    ${d.buyAttempts}  |  Sell attempts: ${d.sellAttempts}`,
            `Rejected orders: ${d.rejectedOrders}`,
          )
          if (Object.keys(d.rejectionReasons).length > 0) {
            lines.push(`Rejection reasons:`)
            for (const [reason, count] of Object.entries(d.rejectionReasons)) {
              lines.push(`  • ${reason}: ${count}`)
            }
          }
          if (d.priceFirst > 0) {
            lines.push(`Price range:     $${fmt(d.priceFirst)} → $${fmt(d.priceLast)} (${fmtPct(d.priceRangePct)} range)`)
          }
          if (d.strategyErrors > 0) {
            lines.push(`Strategy errors: ${d.strategyErrors} (check stderr for details)`)
          }
          // Sizing check: when the share price is large relative to capital,
          // floor(qty) can round to 0. HOW small qty gets depends on the sizing
          // pattern, so we describe both rather than prescribing a single
          // risk_pct threshold (which only applies to allocation sizing).
          const capital = parseFloat(params.capital) || 10000
          if (d.priceFirst > 0) {
            const minPctForOneShare = (d.priceFirst / capital) * 100
            if (minPctForOneShare > 3) {
              const sym = r.v2?.symbols?.[0] ?? "Asset"
              lines.push(
                ``,
                `⚠ POSITION SIZING CHECK: ${sym} trades at ~$${fmt(d.priceFirst, 0)}/share against $${fmt(capital, 0)} capital.`,
                `  • Allocation sizing (qty = equity × alloc_pct / price): you need alloc_pct ≥ ${fmt(minPctForOneShare, 1)}% just to afford 1 share.`,
                `  • Risk-based sizing (qty = equity × risk_pct / stop_dist, then cash-capped): whether floor(qty)=0`,
                `    depends on the STOP DISTANCE, not just price. A tight stop_pct needs a far smaller risk_pct than ${fmt(minPctForOneShare, 1)}%`,
                `    to reach 1 share — but a very small risk_pct still floors to 0.`,
                `  Inspect the computed qty before AND after the cash cap. FIX: raise the sizing %, widen the stop,`,
                `  raise starting capital, or use fractional shares (qty = round(qty, 2)) where supported.`,
              )
            }
          }
          const likelyCause = zeroTradeLikelyCause(d)
          if (likelyCause.length > 0) {
            lines.push(``, ...likelyCause)
          }
          lines.push(`────────────────────────────────────────────────────`)
        }

        let failureDiagnosis: FailureDiagnosis | undefined
        if (quality.label === "failed" || r.totalReturn <= 0 || r.sharpeRatio <= 0) {
          failureDiagnosis = classifyCompletedBacktestFailure({
            results: r,
            quality,
            code: algo.code,
            assetClass,
            interval: params.interval,
          })
          if (failureDiagnosis && codePatternWarnings.length > 0) {
            failureDiagnosis = {
              ...failureDiagnosis,
              codePatternWarnings: [
                ...(failureDiagnosis.codePatternWarnings ?? []),
                ...codePatternWarnings.filter((w) => !(failureDiagnosis?.codePatternWarnings ?? []).includes(w)),
              ],
            }
          }
          if (failureDiagnosis) {
            lines.push(...formatFailureDiagnosisBlock(failureDiagnosis))
          }
        }

        // Engine + assumptions footer — surfaces fill model, fee/slippage
        // assumptions, kill-switch trips, and parse-warning fallout so
        // consumers don't silently miss them.
        if (r.engineVersion || r.diagnostics?.assumptions || r.evidenceError) {
          lines.push(``, `── ENGINE & ASSUMPTIONS ────────────────────────────`)
          if (r.engineVersion) lines.push(`Engine: ${r.engineVersion} (schema_version=${r.schemaVersion ?? "?"})`)
          if (r.runId) lines.push(`Run ID: ${r.runId}`)
          lines.push(`Review experiment ID: ${trial.reference.experimentId}`)
          if (r.artifactDir) lines.push(`Artifacts: ${r.artifactDir}`)
          if (r.evidenceDir) lines.push(`Evidence: ${r.evidenceDir}`)
          if (r.evidenceError) lines.push(`Evidence error: ${r.evidenceError}`)
          if (r.eligibilityStatus) lines.push(`Eligibility: ${r.eligibilityStatus}`)
          if (r.diagnostics?.assumptions) {
            const a = r.diagnostics.assumptions
            const fee = a.taker_fee_bps != null ? `${a.taker_fee_bps.toFixed(2)} bps taker` : `${(((a.fee_rate ?? 0) * 100).toFixed(3))}%`
            const slip = a.slippage_bps != null ? `${a.slippage_bps.toFixed(2)} bps + ATR/volume impact` : `${(((a.slippage ?? 0) * 100).toFixed(3))}%`
            lines.push(`Fill model: ${a.fill_model}  |  fee=${fee}  |  slippage=${slip}`)
            if (a.participation_cap_pct != null) {
              lines.push(`Participation cap: ${a.participation_cap_pct.toFixed(1)}% of bar volume (binding)`)
            }
          }
          if (r.diagnostics?.participationWarningCount && r.diagnostics.participationWarningCount > 0) {
            lines.push(`[!] ${r.diagnostics.participationWarningCount} fills exceeded participation cap — review diagnostics`)
          }
          if (r.diagnostics?.killed) {
            const k = r.diagnostics.killed
            lines.push(`[!] KILL SWITCH TRIPPED — ${k.reason}` + (k.equity !== undefined ? ` (equity=${k.equity.toFixed(2)}, threshold=${(k.threshold ?? 0).toFixed(2)})` : ""))
          }
          if (r.diagnostics?.pendingOrdersAtEnd && r.diagnostics.pendingOrdersAtEnd > 0) {
            lines.push(`${r.diagnostics.pendingOrdersAtEnd} order(s) remained pending at end of window (placed on the last bar, never filled).`)
          }
          if (r.diagnostics?.sharpeUndefinedReason) {
            lines.push(`Sharpe undefined — reason: ${r.diagnostics.sharpeUndefinedReason}`)
          }
          if (r.diagnostics?.parseWarnings && r.diagnostics.parseWarnings.length > 0) {
            lines.push(`Parse warnings: ${r.diagnostics.parseWarnings.join(", ")}`)
          }
          lines.push(`────────────────────────────────────────────────────`)
        }

        const finalOutput = riskBanner
          ? `${riskBanner}\n\n${lines.join("\n")}`
          : lines.join("\n")

        return {
          title: `Backtest: ${algo.name} (${params.duration}, ${params.interval})`,
          output: finalOutput,
          metadata: {
            algorithmName: algo.name,
            params: {
              duration: params.duration,
              interval: params.interval,
              capital: params.capital,
              startDate: effectiveStartDate,
              endDate: effectiveEndDate,
            },
            results: { ...r, v2: undefined },
            dataSourceMode: dataSource.kind,
            qualificationEligible: dataSource.kind === "verified_artifact",
            evidenceIssues: evidence.ok ? [] : evidence.issues,
            walkForward,
            verdict: unified.verdict,
            verdictReasons: unified.reasons,
            consistencyLabel: r.v2?.consistency?.label,
            decayLabel: r.v2?.alpha_decay?.label,
            reviewPacket,
            ...(paperApprovalChallengeId
              ? {
                  approvalChallengeId: paperApprovalChallengeId,
                  paperApprovalChallengeId,
                }
              : {}),
            ...(experiment
              ? {
                  experiment: {
                    ...experiment.trials,
                    experimentId: trial.reference.experimentId,
                    workflowId: experiment.workflow.workflowId,
                    conceptId: experiment.conceptId,
                    replayKey: experiment.replayKey,
                    workflowStage: workflow?.stage,
                    runIdentityHash: workflow?.backtest?.identityHash,
                  },
                }
              : {}),
            experimentLedger: trial.reference,
            ...(failureDiagnosis ? { failure_diagnosis: failureDiagnosis } : {}),
          },
        }
        }))
        if (resultExit._tag === "Failure") {
          yield* Effect.promise(() =>
            runWorkflow(
              failActiveWorkflowBacktest({
                sessionId: ctx.sessionID,
                reason: "backtest execution threw after strict execution started",
              }),
            ).catch(() => undefined),
          )
          yield* Effect.promise(() =>
            runWorkflow(recordWorkflowAttempt({
              sessionId: ctx.sessionID,
              operation: "finny_backtest:finish",
              fingerprint,
              idempotencyKey: `backtest:finish:${fingerprint}:failed`,
              outcome: "failed",
              lifecycle: "terminal",
              blockerCode: "backtest_execution_failed",
              requiredChanges: ["resolve the thrown backtest or preflight error"],
            })),
          )
          return yield* Effect.failCause(resultExit.cause)
        }
        const result = resultExit.value
        const blocked = /\bblocked\b/i.test(result.title) || /^BLOCKED:/m.test(result.output)
        const resultMetadata = result.metadata as Record<string, any>
        yield* Effect.promise(() =>
          runWorkflow(recordWorkflowAttempt({
            sessionId: ctx.sessionID,
            operation: "finny_backtest:finish",
            fingerprint,
            idempotencyKey: `backtest:finish:${fingerprint}:${blocked ? "blocked" : "accepted"}`,
            outcome: blocked ? "blocked" : "accepted",
            lifecycle: "terminal",
            blockerCode: blocked ? "backtest_preflight_rejected" : undefined,
            requiredChanges: blocked ? ["rejected backtest preflight inputs"] : [],
            artifactIds: resultMetadata.results?.runId ? [String(resultMetadata.results.runId)] : [],
            trialIds:
              resultMetadata.experiment && typeof resultMetadata.experiment === "object" && "experimentId" in resultMetadata.experiment
                ? [String(resultMetadata.experiment.experimentId)]
                : [],
          })),
        )
        return result
      }),
    }
  }),
)
