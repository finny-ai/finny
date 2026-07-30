import type { BacktestRunner } from "./runner"
import { dynamicMinTrades } from "./evaluation"
import {
  candidateMatchesExperimentPlanV1,
  verifyExperimentPlanV1,
  type ExperimentPlanV1,
  type ExperimentWindowV1,
} from "./experiment-plan"
import { qualifyCandidateV1, type QualificationBlockerV1, type QualifyCandidateResultV1 } from "./qualification"
import type {
  QualificationAttemptLedgerV1,
  QualificationExecutionIdentityV1,
} from "./qualification-attempt-ledger"
import {
  confirmatoryPolicyErrors,
  makeExploratoryQualificationPolicyV1,
  qualificationInputErrors,
  type HoldoutOpenEventV1,
  type QualificationContextV1,
  type QualificationInputV1,
  type QualificationPolicyV1,
} from "./qualification-policy"

export type PlanExecutionPhase = "exploratory" | "validation" | "confirmatory"

export const REDUCED_EXPLORATORY_WALK_FORWARD_FOLDS = 2

export function walkForwardFoldsForPhase(
  phase: PlanExecutionPhase,
  policy: Pick<QualificationPolicyV1, "minWalkForwardFolds">,
): number {
  return phase === "confirmatory" ? policy.minWalkForwardFolds : REDUCED_EXPLORATORY_WALK_FORWARD_FOLDS
}

export interface PhaseExecutionInputV1 {
  candidateId: string
  plan: ExperimentPlanV1
  phase: PlanExecutionPhase
  window: ExperimentWindowV1
  qualification: QualificationInputV1
  walkForwardFolds: number
}

export type PhaseExecutorV1 = (input: PhaseExecutionInputV1) => Promise<BacktestRunner.RunResult>

type PhaseRunOutcomeV1 =
  | { blocker: QualificationBlockerV1; result?: never }
  | { result: BacktestRunner.RunResult; blocker?: never }

export type QualificationOperationResultV1 =
  | { ok: true; decision: QualifyCandidateResultV1; completedPhases: PlanExecutionPhase[] }
  | { ok: false; blocker: QualificationBlockerV1; completedPhases: PlanExecutionPhase[] }

function blocker(
  code: QualificationBlockerV1["code"],
  field: string,
  message: string,
  next: string,
): QualificationBlockerV1 {
  return {
    schema: "finny.qualification_blocker",
    version: 1,
    code,
    field,
    message,
    nextAllowedTransition: next,
  }
}

function contextFor(input: {
  plan: ExperimentPlanV1
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
    datasetEvidenceId: input.plan.datasetEvidence.datasetEvidenceId,
    datasetHash: input.plan.datasetEvidence.datasetHash,
    datasetQualification: input.plan.datasetEvidence.qualification,
    dataQualityMode: "strict",
  }
}

function invalidPlanBlocker(input: OperationInput) {
  const planError = verifyExperimentPlanV1(input.plan)[0]
  if (planError) return blocker("invalid_policy", "experimentPlanId", planError, "compile and persist a valid ExperimentPlanV1")
}

function invalidPolicyBlocker(input: OperationInput) {
  const policyError = confirmatoryPolicyErrors(input.policy)[0]
  if (policyError) return blocker("invalid_policy", "qualificationPolicy", policyError, "supply the exact immutable policy")
  const matches = [
    input.plan.qualificationPolicyId === input.policy.policyId,
    input.plan.qualificationPolicyHash === input.policy.policyHash,
  ].every(Boolean)
  if (!matches) {
    return blocker("invalid_policy", "qualificationPolicy", "policy does not match the compiled plan", "load the immutable policy bound to this plan")
  }
}

function invalidCandidateBlocker(input: OperationInput) {
  if (!candidateMatchesExperimentPlanV1({ plan: input.plan, candidateId: input.candidateId, ...input.executionIdentity })) {
    return blocker(
      "invalid_policy",
      "candidateId",
      "candidate identity, code, or config does not match the compiled experiment plan",
      "compile a new plan for this exact candidate version",
    )
  }
}

function invalidDatasetBlocker(input: OperationInput) {
  if (input.plan.datasetEvidence.qualification !== "strict_qualified") {
    return blocker(
      "dataset_not_strict_qualified",
      "datasetQualification",
      `dataset qualification ${input.plan.datasetEvidence.qualification} is not promotable`,
      "obtain authoritative strict_qualified DatasetEvidence for this exact plan",
    )
  }
}

function planBlocker(input: OperationInput): QualificationBlockerV1 | undefined {
  return [
    invalidPlanBlocker(input),
    invalidPolicyBlocker(input),
    invalidCandidateBlocker(input),
    invalidDatasetBlocker(input),
  ].find((candidate) => candidate !== undefined)
}

function holdoutBlocker(events: readonly HoldoutOpenEventV1[]): QualificationBlockerV1 | undefined {
  if (events.length === 1) return undefined
  return blocker(
    "sealed_holdout_required",
    "holdoutOpenEvents",
    `sealed holdout has ${events.length} durable open events; exactly one is required`,
    "record one approved holdout-open event bound to this experiment plan",
  )
}

function contractBlocker(qualification: QualificationInputV1): QualificationBlockerV1 | undefined {
  const error = qualificationInputErrors(qualification)[0]
  if (!error) return undefined
  const holdout = error.includes("holdout")
  return blocker(
    holdout ? "sealed_holdout_required" : "invalid_policy",
    holdout ? "holdoutOpenEvents" : "qualification",
    error,
    "record one matching approved holdout-open event or repair the immutable qualification input",
  )
}

function executionBlocker(phase: PlanExecutionPhase, result: BacktestRunner.RunResult): QualificationBlockerV1 | undefined {
  if (result.ok) return undefined
  return blocker(
    "quality_gates_failed",
    phase,
    `${phase} execution failed: ${result.error}`,
    `fix the ${phase} execution blocker and retry with a new candidate version or plan`,
  )
}

function preHoldoutMetricReasons(input: {
  results: BacktestRunner.Results
  policy: QualificationPolicyV1
}): string[] {
  const minimumTrades = Math.max(
    dynamicMinTrades(input.results),
    input.policy.minTrades,
    input.policy.minEffectiveSampleSize,
  )
  const walkForward = input.results.v2?.walk_forward
  const stitchedOosReturn = walkForward?.stitched_oos_return
  const costSensitivity = input.results.sensitivityOutcomes?.find((item) => /cost|fee|slippage/i.test(item.name))
  const checks = [
    {
      valid: input.results.totalTrades >= minimumTrades,
      error: `closed trade count below minimum for this window (${input.results.totalTrades} < ${minimumTrades})`,
    },
    {
      valid: typeof stitchedOosReturn === "number" && Number.isFinite(stitchedOosReturn) && stitchedOosReturn > 0,
      error: walkForward ? "stitched OOS return must be positive" : "stitched OOS return is unavailable",
    },
    {
      valid: !input.policy.requireCostSensitivity || costSensitivity?.status === "pass",
      error: "configured cost sensitivity did not pass",
    },
  ]
  return checks.filter((check) => !check.valid).map((check) => check.error)
}

function preHoldoutMetricBlocker(input: {
  phase: PlanExecutionPhase
  result: BacktestRunner.RunResult
  policy: QualificationPolicyV1
}): QualificationBlockerV1 | undefined {
  if (!input.result.ok || input.phase === "confirmatory") return undefined
  const reasons = preHoldoutMetricReasons({ results: input.result.results, policy: input.policy })
  if (reasons.length === 0) return undefined
  return blocker(
    "quality_gates_failed",
    input.phase,
    `${input.phase} metrics failed before sealed-holdout access: ${reasons.join("; ")}`,
    `revise the candidate without opening the holdout, then compile a new plan before retrying ${input.phase}`,
  )
}

export interface OperationInput {
  candidateId: string
  plan: ExperimentPlanV1
  holdoutOpenEvents: readonly HoldoutOpenEventV1[]
  executePhase: PhaseExecutorV1
  policy: QualificationPolicyV1
  attemptLedger: QualificationAttemptLedgerV1
  executionIdentity: QualificationExecutionIdentityV1
}

function attemptIdentity(input: OperationInput, phase: PlanExecutionPhase | "preflight") {
  return {
    plan: input.plan,
    candidateId: input.candidateId,
    phase,
    policy: input.policy,
    executionIdentity: input.executionIdentity,
  }
}

async function recordCurrentBlocker(
  input: OperationInput,
  phase: PlanExecutionPhase | "preflight",
  value: QualificationBlockerV1,
) {
  return input.attemptLedger.block({ ...attemptIdentity(input, phase), blocker: value })
}

async function claimedPhaseOutcome(
  input: OperationInput,
  phase: PlanExecutionPhase,
  claim: Awaited<ReturnType<QualificationAttemptLedgerV1["claim"]>>,
): Promise<PhaseRunOutcomeV1 | undefined> {
  if (claim.kind === "blocked") return { blocker: claim.blocker }
  if (claim.kind !== "completed") return undefined
  const cachedFailure = preHoldoutMetricBlocker({ phase, result: claim.result, policy: input.policy })
  if (cachedFailure) return { blocker: await recordCurrentBlocker(input, phase, cachedFailure) }
  return { result: claim.result }
}

async function executePhaseSafely(
  input: OperationInput,
  phase: PlanExecutionPhase,
  qualification: QualificationInputV1,
): Promise<BacktestRunner.RunResult> {
  try {
    return await input.executePhase({
      candidateId: input.candidateId,
      plan: input.plan,
      phase,
      window: input.plan.windows[phase],
      qualification,
      walkForwardFolds: walkForwardFoldsForPhase(phase, input.policy),
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), kind: "internal" } as const
  }
}

async function runPhase(input: OperationInput, phase: PlanExecutionPhase, trial: number): Promise<PhaseRunOutcomeV1> {
  const policy =
    phase === "confirmatory"
      ? input.policy
      : makeExploratoryQualificationPolicyV1({ requiredPhase: phase })
  const qualification: QualificationInputV1 = {
    policy,
    context: contextFor({ plan: input.plan, phase, trial, holdoutOpenEvents: input.holdoutOpenEvents }),
  }
  if (phase === "confirmatory") {
    const blocked = holdoutBlocker(input.holdoutOpenEvents) ?? contractBlocker(qualification)
    if (blocked) return { blocker: await recordCurrentBlocker(input, phase, blocked) }
  }
  const identity = attemptIdentity(input, phase)
  const claim = await input.attemptLedger.claim(identity)
  const claimed = await claimedPhaseOutcome(input, phase, claim)
  if (claimed) return claimed
  const result = await executePhaseSafely(input, phase, qualification)
  const failed = executionBlocker(phase, result) ?? preHoldoutMetricBlocker({ phase, result, policy })
  await input.attemptLedger.complete({ ...identity, attemptId: claim.attemptId, result, blocker: failed })
  if (failed) return { blocker: failed }
  return { result }
}

export async function executeQualificationPlanV1(input: OperationInput): Promise<QualificationOperationResultV1> {
  const invalid = planBlocker(input)
  if (invalid) return { ok: false, blocker: await recordCurrentBlocker(input, "preflight", invalid), completedPhases: [] }
  const phases: PlanExecutionPhase[] = ["exploratory", "validation", "confirmatory"]
  const completedPhases: PlanExecutionPhase[] = []
  let finalResults: BacktestRunner.Results | undefined
  for (const [index, phase] of phases.entries()) {
    const outcome = await runPhase(input, phase, index + 1)
    if (outcome.blocker) return { ok: false, blocker: outcome.blocker, completedPhases }
    if (outcome.result.ok) {
      completedPhases.push(phase)
      finalResults = outcome.result.results
    }
  }
  const qualification: QualificationInputV1 = {
    policy: input.policy,
    context: contextFor({ plan: input.plan, phase: "confirmatory", trial: phases.length, holdoutOpenEvents: input.holdoutOpenEvents }),
  }
  const decision = qualifyCandidateV1({ candidateId: input.candidateId, results: finalResults!, qualification })
  if (decision.ok) return { ok: true, decision, completedPhases }
  return {
    ok: false,
    blocker: await recordCurrentBlocker(input, "confirmatory", decision.blocker),
    completedPhases,
  }
}

export async function executeQualificationWithHoldoutApprovalV1(
  input: Omit<OperationInput, "holdoutOpenEvents"> & {
    readHoldoutOpenEvents: () => Promise<readonly HoldoutOpenEventV1[]>
    requestHoldoutApproval: () => Promise<boolean>
  },
): Promise<QualificationOperationResultV1> {
  const initialEvents = await input.readHoldoutOpenEvents()
  const first = await executeQualificationPlanV1({ ...input, holdoutOpenEvents: initialEvents })
  if (first.ok) return first
  const atBoundary = [
    first.blocker.code === "sealed_holdout_required",
    first.completedPhases.join(",") === "exploratory,validation",
    initialEvents.length === 0,
  ].every(Boolean)
  if (!atBoundary) return first
  if (!(await input.requestHoldoutApproval())) return first
  const approvedEvents = await input.readHoldoutOpenEvents()
  return executeQualificationPlanV1({ ...input, holdoutOpenEvents: approvedEvents })
}
