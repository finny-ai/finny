import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { Algorithm } from "@/algorithm"
import type { RequestSpec } from "@/agent/request-spec"
import type { VerifiedDatasetRef } from "@/data/data-extractor-evidence"
import type { BacktestRunner } from "../runner"
import {
  compileExperimentPlanV2,
  type ExperimentPlanV2,
  type ExperimentWindowV1,
  type PlanSymbolBindingV2,
  verifyExperimentPlanV2,
} from "../experiment-plan"
import {
  DurableQualificationAttemptLedgerV1,
  type QualificationAttemptLedgerV1,
  type QualificationExecutionIdentityV1,
} from "../qualification-attempt-ledger"
import {
  makeExploratoryQualificationPolicyV1,
  confirmatoryPolicyErrors,
  qualificationInputErrors,
  type HoldoutOpenEventV1,
  type QualificationContextV1,
  type QualificationInputV1,
  type QualificationPolicyV1,
} from "../qualification-policy"
import { qualifyCandidateV1, type QualificationBlockerV1 } from "../qualification"
import { qualificationHash } from "../qualification-policy"
import { ExperimentPlanV2CompileError } from "../experiment-plan"
import { LEAN_PINNED_COMMIT, LEAN_PINNED_IMAGE_DIGEST, leanExecutionProfileV1 } from "./contracts"
import { buildLeanLauncherConfig } from "./engine-config"
import { materializeLeanDataBundle } from "./materialize"
import { parseFinnyOhlcv, writeLeanMarketData } from "./data-writer"
import { canonicalizeLeanArtifacts } from "./parse"
import { runLeanPhase } from "./run"
import type { LeanAdapterV1 } from "./runner"
import type { LeanBarScheduleV1 } from "./types"
import { runtimeForCandidate } from "./select"
import { leanSourceDir, sourceFilesForAlgorithm } from "./source-store"
import { isLeanProfile, runtimeProfileV1, strategySourceV1 } from "./contracts"

const LEAN_ADAPTER_HASH = crypto
  .createHash("sha256")
  .update("finny-lean-adapter-v1")
  .digest("hex")
const CALENDAR_POLICY_VERSION = "finny-calendars-2026.1"

export type PlanExecutionPhase = "exploratory" | "validation" | "confirmatory"

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function timestampsFromCsv(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const header = lines[0]?.split(",").map((value) => value.trim().toLowerCase()) ?? []
  const index = header.indexOf("timestamp")
  if (index < 0) throw new Error("verified dataset CSV has no timestamp column")
  return lines.slice(1).map((line) => {
    const raw = line.split(",")[index]?.trim().replace(/^"|"$/g, "")
    const parsed = Date.parse(raw)
    if (!Number.isFinite(parsed)) throw new Error("verified dataset CSV contains an invalid timestamp")
    return new Date(parsed).toISOString()
  })
}

function scheduleFromCsv(input: { csvText: string; symbol: string; assetClass: "equity" | "crypto_spot"; interval: string }): LeanBarScheduleV1 {
  const timestamps = timestampsFromCsv(input.csvText)
  return {
    symbol: input.symbol,
    assetClass: input.assetClass,
    interval: input.interval,
    calendarId: input.assetClass === "equity" ? "XNYS" : "24-7",
    calendarVersion: CALENDAR_POLICY_VERSION,
    timezone: input.assetClass === "equity" ? "America/New_York" : "UTC",
    bars: timestamps.map((timestamp) => ({
      timestamp,
      sessionId: timestamp.slice(0, 10),
    })),
    scheduleHash: sha256Text(timestamps.join("\n")),
  }
}

function configRecord(candidate: Algorithm.Info): Record<string, any> {
  try {
    return JSON.parse(candidate.config ?? "{}") as Record<string, any>
  } catch {
    return {}
  }
}

function requiredRequest(request: RequestSpec) {
  const missing = () => new Error("active RequestSpec must contain interval, requested_start, and requested_end")
  if (!request.requested_interval) throw missing()
  if (!request.requested_start) throw missing()
  if (!request.requested_end) throw missing()
  return {
    requestId: request.request_id,
    requestVersion: request.request_version,
    requestHash: request.content_hash,
    interval: request.requested_interval,
    requestedStart: request.requested_start,
    requestedEnd: request.requested_end,
  }
}

function assetClassFor(config: Record<string, any>, dataset: VerifiedDatasetRef): "equity" | "crypto_spot" {
  const raw = String(config.asset_class ?? dataset.identity.actualAssetClass ?? "").toLowerCase()
  if (raw === "equity" || raw === "etf") return "equity"
  if (raw.includes("crypto")) return "crypto_spot"
  throw new Error(`LEAN v1 qualification supports only equity and crypto_spot; received ${raw}`)
}

function executionProfileFor(config: Record<string, any>, assetClass: "equity" | "crypto_spot") {
  const execution = (config.execution ?? {}) as Record<string, any>
  return leanExecutionProfileV1({
    assetClass,
    makerFeeBps: Number(execution.maker_fee_bps ?? 0),
    takerFeeBps: Number(execution.taker_fee_bps ?? 0),
    slippageBps: Number(execution.slippage_bps ?? 0),
    maxLeverage: Number(execution.max_leverage ?? 1),
    maintenanceMarginPct: Number(execution.maintenance_margin_pct ?? 0.5),
    shortingEnabled: false,
    dataFeedWorkers: 1,
  })
}

function windowsFromBars(input: { timestamps: string[]; warmupBars: number }): ExperimentPlanV2["windows"] {
  if (!Number.isSafeInteger(input.warmupBars) || input.warmupBars < 0) {
    throw new ExperimentPlanV2CompileError(
      "insufficient_bars",
      `warmupBars must be a non-negative integer; received ${input.warmupBars}`,
    )
  }
  const total = input.timestamps.length
  const warmupCount = Math.min(input.warmupBars, total)
  const usable = Math.max(0, total - warmupCount)
  if (usable < 3) {
    throw new ExperimentPlanV2CompileError(
      "insufficient_bars",
      `authoritative schedule has ${total} bars (${usable} usable after ${warmupCount} warmup); at least 3 usable bars are required to fill exploratory, validation, and confirmatory windows`,
    )
  }
  const validation = Math.max(1, Math.floor(usable * 0.2))
  const confirmatory = Math.max(1, Math.floor(usable * 0.2))
  const exploratory = usable - validation - confirmatory
  if (exploratory < 1) {
    throw new ExperimentPlanV2CompileError(
      "insufficient_bars",
      `authoritative schedule cannot fill a non-empty exploratory window after validation and confirmatory split`,
    )
  }
  const slice = (start: number, count: number): ExperimentWindowV1 => {
    const bars = input.timestamps.slice(start, start + count)
    return {
      start: bars[0]?.slice(0, 10) ?? "",
      end: bars.at(-1)?.slice(0, 10) ?? "",
      bars: bars.length,
      sessions: new Set(bars.map((t) => t.slice(0, 10))).size,
      firstSessionId: bars[0]?.slice(0, 10) ?? "",
      lastSessionId: bars.at(-1)?.slice(0, 10) ?? "",
    }
  }
  const warmup = input.timestamps.slice(0, warmupCount)
  return {
    warmup: {
      start: warmup[0]?.slice(0, 10) ?? "",
      end: warmup.at(-1)?.slice(0, 10) ?? "",
      bars: warmup.length,
      sessions: new Set(warmup.map((t) => t.slice(0, 10))).size,
      firstSessionId: warmup[0]?.slice(0, 10) ?? "",
      lastSessionId: warmup.at(-1)?.slice(0, 10) ?? "",
    },
    exploratory: slice(warmupCount, exploratory),
    validation: slice(warmupCount + exploratory, validation),
    confirmatory: slice(warmupCount + exploratory + validation, confirmatory),
  }
}

/**
 * Compile a V2 plan from the active immutable request and one verified strict
 * dataset (v1 qualification is single-symbol; multi-symbol universes arrive
 * with the portfolio qualification slice).
 */
export async function compileLeanPlanV2FromActiveEvidence(input: {
  request: RequestSpec
  dataset: VerifiedDatasetRef
  candidate: Algorithm.Info
  policy: QualificationPolicyV1
  /**
   * The local-leg LEAN profile for a qc_cloud candidate bound to a linked
   * QuantConnect project. The QC Cloud leg and the local Crucible leg are
   * separate evaluations; the local leg always runs the pinned LEAN engine
   * in the project's language.
   */
  runtimeProfileOverride?: "lean_python" | "lean_csharp"
}): Promise<ExperimentPlanV2> {
  const runtime = runtimeForCandidate(input.candidate)
  const localProfileId: "lean_python" | "lean_csharp" | undefined =
    input.runtimeProfileOverride ??
    (isLeanProfile(runtime.profile) ? runtime.profile.profileId : undefined)
  if (!localProfileId) {
    throw new Error(
      `candidate runtime ${runtime.profile.profileId} is not a local LEAN runtime; a qc_cloud local leg requires an explicit LEAN profile override`,
    )
  }
  if (input.runtimeProfileOverride && isLeanProfile(runtime.profile) && input.runtimeProfileOverride !== runtime.profile.profileId) {
    throw new Error(
      `candidate runtime ${runtime.profile.profileId} conflicts with the requested local-leg profile ${input.runtimeProfileOverride}`,
    )
  }
  const config = configRecord(input.candidate)
  const assetClass = assetClassFor(config, input.dataset)
  const csvText = await fs.readFile(input.dataset.csvPath, "utf8")
  const timestamps = timestampsFromCsv(csvText)
  const schedule = scheduleFromCsv({
    csvText,
    symbol: input.dataset.identity.actualSymbol,
    assetClass,
    interval: String(config.interval ?? input.dataset.identity.actualInterval ?? "1h"),
  })
  const binding: PlanSymbolBindingV2 = {
    canonicalSymbol: input.dataset.identity.actualSymbol,
    assetClass,
    datasetEvidenceId: `dataset-${input.dataset.manifestSha256.slice(0, 24)}`,
    datasetHash: input.dataset.csvSha256,
    manifestHash: input.dataset.manifestSha256,
    scheduleHash: schedule.scheduleHash,
    actualStart: input.dataset.identity.actualStart,
    actualEnd: input.dataset.identity.actualEnd,
  }
  const executionProfile = executionProfileFor(config, assetClass)
  // The plan binds the exact strategy source tree the pinned engine will
  // mount. Candidates without an embedded source manifest (legacy saves and
  // qc_cloud links) get the real per-version tree instead of an empty hash.
  const sourceManifest =
    runtime.source && runtime.source.profileId === localProfileId
      ? runtime.source
      : strategySourceV1({
          profileId: localProfileId,
          files: await sourceFilesForAlgorithm(input.candidate),
        })
  const warmupBars = Number.isInteger(config.required_history_bars) ? Number(config.required_history_bars) : 1
  const leanConfigHash = buildLeanLauncherConfig({
    profile: executionProfile,
    assetFamily: assetClass,
    startDate: binding.actualStart,
    endDate: binding.actualEnd,
    cash: Number(config.risk?.starting_equity_usd ?? 10000),
    algorithmTypeName: "Main",
    // Must match the launcher config the adapter actually executes so the
    // plan-bound hash is the hash of the executed config.
    algorithmLanguage: localProfileId === "lean_csharp" ? "CSharp" : "Python",
    algorithmLocation:
      localProfileId === "lean_csharp" ? "/Lean/Algorithm/Algorithm.dll" : "/Lean/Algorithm/main.py",
    dataFolder: "/Lean/Data",
    resultsFolder: "/Results",
    seed: 0,
    dataFeedWorkers: 1,
  }).configHash

  const plan = compileExperimentPlanV2({
    request: requiredRequest(input.request),
    candidate: {
      candidateId: input.candidate.algorithmId,
      // Must match the executionIdentity hashes used by the qualification
      // tool's resume check (qualificationHash of the stable representation).
      codeHash: qualificationHash(input.candidate.code),
      configHash: qualificationHash(input.candidate.config ?? ""),
      warmupBars,
      declaredSearchBudget: Number(config.declared_search_budget ?? config.optimization_budget ?? 1),
    },
    runtime: {
      profileId: localProfileId,
      profileHash: runtimeProfileV1(localProfileId).profileHash,
      sourceTreeHash: sourceManifest.sourceTreeHash,
      adapterHash: LEAN_ADAPTER_HASH,
      executionProfileHash: executionProfile.executionProfileHash,
      imageDigest: LEAN_PINNED_IMAGE_DIGEST,
      leanCommit: LEAN_PINNED_COMMIT,
      leanConfigHash,
    },
    datasets: [binding],
    interval: schedule.interval,
    warmupBars,
    declaredSearchBudget: Number(config.declared_search_budget ?? config.optimization_budget ?? 1),
    calendarPolicyVersion: CALENDAR_POLICY_VERSION,
    qualificationPolicy: input.policy,
    windows: windowsFromBars({ timestamps, warmupBars }),
  })
  return plan
}

function blocker(code: string, field: string, message: string, next: string): QualificationBlockerV1 {
  return {
    schema: "finny.qualification_blocker",
    version: 1,
    code: code as QualificationBlockerV1["code"],
    field,
    message,
    nextAllowedTransition: next,
  }
}

function contextFor(input: {
  plan: ExperimentPlanV2
  phase: PlanExecutionPhase
  trial: number
  holdoutOpenEvents: readonly HoldoutOpenEventV1[]
}): QualificationContextV1 {
  return {
    schema: "finny.qualification_context",
    version: 1,
    planId: input.plan.planId,
    planHash: input.plan.planHash,
    phase: input.phase,
    holdoutOpenEvents: input.phase === "confirmatory" ? input.holdoutOpenEvents : [],
    durableSelectionBudget: input.plan.declaredSearchBudget,
    durableTrialCount: input.trial,
    datasetEvidenceId: input.plan.datasets[0]?.datasetEvidenceId ?? "",
    datasetHash: input.plan.datasetCompositeHash,
    datasetQualification: "strict_qualified",
    dataQualityMode: "strict",
  }
}

function leanResultsToRunResult(result: ReturnType<typeof canonicalizeLeanArtifacts>): BacktestRunner.RunResult {
  return {
    ok: true,
    results: {
      totalReturn: result.totalReturn,
      maxDrawdown: result.maxDrawdown,
      annualizedVolatility: result.annualizedVolatility,
      sharpeRatio: result.sharpeRatio,
      endingEquity: result.endingEquity,
      totalTrades: result.totalTrades,
      closedTrades: result.totalTrades,
      winRate: result.winRate,
      profitFactor: result.profitFactor,
      fees: result.fees,
      engineVersion: result.engineVersion,
      runKind: "crucible_2_0",
      v2: undefined,
      diagnostics: result.diagnostics,
    } as unknown as BacktestRunner.Results,
  }
}

export async function executeLeanQualificationV2(input: {
  candidate: Algorithm.Info
  dataset: VerifiedDatasetRef
  plan: ExperimentPlanV2
  policy: QualificationPolicyV1
  executionIdentity: QualificationExecutionIdentityV1
  adapter: LeanAdapterV1
  attemptLedger?: QualificationAttemptLedgerV1
  readHoldoutOpenEvents: () => Promise<readonly HoldoutOpenEventV1[]>
  requestHoldoutApproval: () => Promise<boolean>
}): Promise<{ ok: boolean; completedPhases: PlanExecutionPhase[]; blocker?: QualificationBlockerV1 }> {
  const ledger = input.attemptLedger ?? DurableQualificationAttemptLedgerV1
  const planIdentity = input.plan as unknown as Parameters<QualificationAttemptLedgerV1["claim"]>[0]["plan"]
  const identity = {
    plan: planIdentity,
    candidateId: input.candidate.algorithmId,
    policy: input.policy,
    executionIdentity: input.executionIdentity,
  }
  const planErrors = verifyExperimentPlanV2(input.plan)
  if (planErrors.length) {
    return {
      ok: false,
      completedPhases: [],
      blocker: blocker("invalid_policy", "experimentPlanId", planErrors.join("; "), "repair the V2 plan inputs"),
    }
  }
  const policyErrors = confirmatoryPolicyErrors(input.policy)
  if (policyErrors.length || input.plan.qualificationPolicyHash !== input.policy.policyHash) {
    return {
      ok: false,
      completedPhases: [],
      blocker: blocker("invalid_policy", "qualificationPolicy", policyErrors.join("; "), "supply the exact immutable policy"),
    }
  }

  const initialEvents = [...(await input.readHoldoutOpenEvents())]
  const completedPhases: PlanExecutionPhase[] = []
  const phases: PlanExecutionPhase[] = ["exploratory", "validation", "confirmatory"]
  let finalResult: BacktestRunner.RunResult | undefined

  // Fail closed on any invalid runtime declaration: an explicit invalid or
  // qc_cloud profile must never be coerced back to the default engine or run
  // under a mismatched identity. The local leg of a composite qc_cloud plan
  // runs the pinned LEAN engine under the plan's LEAN profile.
  const runtimeConfig = runtimeForCandidate(input.candidate)
  if (runtimeConfig.issues.length > 0) {
    const failed = blocker(
      "invalid_policy",
      "runtime",
      `Invalid runtime declaration: ${runtimeConfig.issues.join("; ")}. Engine fallback is disabled.`,
      "repair and resave the candidate with an explicit supported runtime profile",
    )
    await ledger.block({ ...identity, phase: "exploratory", blocker: failed })
    return { ok: false, completedPhases, blocker: failed }
  }
  const effectiveProfile = isLeanProfile(runtimeConfig.profile)
    ? runtimeConfig.profile
    : runtimeProfileV1(input.plan.runtime.profileId)
  if (!isLeanProfile(effectiveProfile)) {
    const failed = blocker(
      "invalid_policy",
      "runtime",
      `plan runtime ${input.plan.runtime.profileId} is not a local LEAN profile; the composite local leg runs the pinned LEAN engine`,
      "recompile the plan with a LEAN local-leg profile",
    )
    await ledger.block({ ...identity, phase: "exploratory", blocker: failed })
    return { ok: false, completedPhases, blocker: failed }
  }
  const sourceManifest =
    runtimeConfig.source && runtimeConfig.source.profileId === effectiveProfile.profileId
      ? runtimeConfig.source
      : strategySourceV1({
          profileId: effectiveProfile.profileId,
          files: await sourceFilesForAlgorithm(input.candidate),
        })

  for (const [index, phase] of phases.entries()) {
    const policy = phase === "confirmatory" ? input.policy : makeExploratoryQualificationPolicyV1({ requiredPhase: phase })
    const qualification: QualificationInputV1 = {
      policy,
      context: contextFor({ plan: input.plan, phase, trial: index + 1, holdoutOpenEvents: initialEvents }),
    }
    if (phase === "confirmatory") {
      if (initialEvents.length === 0 && completedPhases.join(",") === "exploratory,validation") {
        const approved = await input.requestHoldoutApproval()
        if (!approved) {
          return {
            ok: false,
            completedPhases: [...completedPhases],
            blocker: blocker(
              "sealed_holdout_required",
              "holdoutOpenEvents",
              "sealed holdout approval was not granted",
              "approve the exact holdout open event for this plan",
            ),
          }
        }
        const refreshed = await input.readHoldoutOpenEvents()
        if (refreshed.length !== 1) {
          return {
            ok: false,
            completedPhases: [...completedPhases],
            blocker: blocker(
              "sealed_holdout_required",
              "holdoutOpenEvents",
              `expected exactly one durable holdout open event after approval; found ${refreshed.length}`,
              "record one approved holdout-open event bound to this experiment plan",
            ),
          }
        }
        initialEvents.push(...refreshed)
      }
      if (initialEvents.length !== 1) {
        return {
          ok: false,
          completedPhases: [...completedPhases],
          blocker: blocker(
            "sealed_holdout_required",
            "holdoutOpenEvents",
            `sealed holdout has ${initialEvents.length} durable open events; exactly one is required`,
            "record one approved holdout-open event bound to this experiment plan",
          ),
        }
      }
      const errors = qualificationInputErrors(qualification)
      if (errors.length) {
        return { ok: false, completedPhases: [...completedPhases], blocker: blocker("invalid_policy", "qualification", errors.join("; "), "repair the qualification input") }
      }
    }

    const claim = await ledger.claim({ ...identity, phase })
    if (claim.kind === "blocked") return { ok: false, completedPhases: [...completedPhases], blocker: claim.blocker }
    if (claim.kind === "completed") {
      completedPhases.push(phase)
      finalResult = claim.result
      continue
    }

    const window = input.plan.windows[phase]
    let outcome: Awaited<ReturnType<typeof runLeanPhase>>
    let phaseRoot: string | undefined
    try {
      phaseRoot = await fs.mkdtemp(path.join("/tmp", "finny-lean-qualify"))
      const csvText = await fs.readFile(input.dataset.csvPath, "utf8")
      const schedule = scheduleFromCsv({
        csvText,
        symbol: input.dataset.identity.actualSymbol,
        assetClass: input.plan.datasets[0]?.assetClass ?? "equity",
        interval: input.plan.interval,
      })
      const dataBundle = await materializeLeanDataBundle({
        phase,
        interval: input.plan.interval,
        assetFamily: input.plan.datasets[0]?.assetClass ?? "equity",
        schedules: [schedule],
        window: { start: window.start, end: window.end },
        warmupBars: input.plan.warmupBars,
        outputDir: phaseRoot,
      })
      // Materialize the actual LEAN on-disk data tree the pinned engine will
      // mount. The bundle manifest alone is not a runnable data bundle.
      const scratchDir = path.join(phaseRoot, "scratch")
      await fs.mkdir(scratchDir, { recursive: true })
      await writeLeanMarketData({
        rows: parseFinnyOhlcv(csvText),
        symbol: input.dataset.identity.actualSymbol,
        assetClass: input.plan.datasets[0]?.assetClass ?? "equity",
        interval: input.plan.interval,
        dataDir: scratchDir,
      })
      outcome = await runLeanPhase({
        adapter: input.adapter,
        context: {
          plan: input.plan,
          bundle: {
            schema: "finny.lean_runtime_bundle",
            version: 1,
            profile: effectiveProfile,
            source: sourceManifest,
            executionProfile: executionProfileFor(configRecord(input.candidate), input.plan.datasets[0]?.assetClass ?? "equity"),
            image: {
              schema: "finny.lean_image_identity",
              version: 1,
              imageRef: "ghcr.io/finny-ai/lean-engine",
              imageDigest: input.plan.runtime.imageDigest,
              leanCommit: input.plan.runtime.leanCommit,
              architectures: ["linux/amd64", "linux/arm64"],
              sbomSha256: "",
              provenanceSha256: "",
            },
            leanConfigHash: input.plan.runtime.leanConfigHash,
            adapterHash: input.plan.runtime.adapterHash,
            runtimeHash: sha256Text(input.plan.planId),
          },
          dataBundle,
          phase,
          window: { start: window.start, end: window.end },
          // The plan binds the launcher config with seed 0; execution must
          // use the same seed so the plan-bound leanConfigHash is the hash of
          // the executed config. Retries of the same plan stay byte-identical.
          seed: 0,
          capital: Number(configRecord(input.candidate).risk?.starting_equity_usd ?? 10000),
          sourceDir: await leanSourceDir(input.candidate),
          resultsDir: path.join(phaseRoot, "results"),
          scratchDir,
        },
        dataBundle,
        canonicalize: (result) =>
          canonicalizeLeanArtifacts({
            artifacts: result.artifacts,
            startingEquity: Number(configRecord(input.candidate).risk?.starting_equity_usd ?? 10000),
            engineVersion: `lean-${input.plan.runtime.leanCommit.slice(0, 8)}`,
            runtimeProfileId: effectiveProfile.profileId,
          }),
      })
    } catch (error) {
      const failed = blocker(
        "quality_gates_failed",
        phase,
        `${phase} preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        `fix the ${phase} data/runtime blocker and retry`,
      )
      await ledger.block({ ...identity, phase, blocker: failed })
      if (phaseRoot) await fs.rm(phaseRoot, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, completedPhases: [...completedPhases], blocker: failed }
    }
    if (!outcome.ok) {
      const failed = blocker("quality_gates_failed", phase, `${phase} execution failed: ${outcome.error}`, `fix the ${phase} execution blocker and retry`)
      await ledger.block({ ...identity, phase, blocker: failed })
      if (phaseRoot) await fs.rm(phaseRoot, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, completedPhases: [...completedPhases], blocker: failed }
    }
    finalResult = leanResultsToRunResult(outcome.result)
    await ledger.complete({ ...identity, phase, attemptId: claim.attemptId, result: finalResult })
    if (phaseRoot) await fs.rm(phaseRoot, { recursive: true, force: true }).catch(() => undefined)
    completedPhases.push(phase)
  }

  const qualification: QualificationInputV1 = {
    policy: input.policy,
    context: contextFor({ plan: input.plan, phase: "confirmatory", trial: phases.length, holdoutOpenEvents: initialEvents }),
  }
  if (!finalResult?.ok) {
    const failed = blocker(
      "quality_gates_failed",
      "confirmatory",
      `confirmatory execution produced no canonical result: ${finalResult?.error ?? "unknown"}`,
      "fix the confirmatory execution blocker and retry",
    )
    await ledger.block({ ...identity, phase: "confirmatory", blocker: failed })
    return { ok: false, completedPhases, blocker: failed }
  }
  const decision = qualifyCandidateV1({
    candidateId: input.candidate.algorithmId,
    results: finalResult.results,
    qualification,
  })
  if (decision.ok) return { ok: true, completedPhases }
  const failed = decision.blocker
  await ledger.block({
    ...identity,
    phase: "confirmatory",
    blocker: failed,
  })
  return { ok: false, completedPhases, blocker: failed }
}

export { LEAN_ADAPTER_HASH, CALENDAR_POLICY_VERSION }
