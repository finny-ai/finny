import { createHash } from "node:crypto"
import { normalizeSymbol } from "@/agent/request-identity"
import { grantApproval, rejectApproval, requestApproval } from "./state-approvals"
import { backtestIdentityHash, experimentReplayKey } from "./state-identity"
import type {
  BacktestHashes,
  BacktestRef,
  BuildWorkflowState,
  ExperimentAttempt,
  TransitionDecision,
  WorkflowEvent,
  RequestIdentity,
  WorkflowStage,
} from "./types"

function rejected(state: BuildWorkflowState, code: string, message: string): TransitionDecision {
  return { allowed: false, code, message, state }
}

function resumeToken(workflowId: string, requestVersion: number) {
  return `wfr_${createHash("sha256").update(`${workflowId}:${requestVersion}`).digest("hex").slice(0, 32)}`
}

function identitySymbols(identity: RequestIdentity): string[] {
  return [
    ...new Set((identity.symbols?.value ?? []).map((item) => normalizeSymbol(item)).filter(Boolean) as string[]),
  ].sort()
}

function requirementsForIdentity(state: BuildWorkflowState, identity: RequestIdentity) {
  const symbols = identitySymbols(identity)
  const market = state.evidenceRequirements.find((requirement) => requirement.kind === "market_data")
  const marketRequirements = !market
    ? []
    : symbols.length === 0
      ? [{ ...market, id: "market_data:request", symbols: [] }]
      : symbols.map((symbol) => ({
          ...market,
          id: `market_data:${symbol}`,
          symbols: [symbol],
          reason: `Verified historical market data is required for ${symbol}.`,
        }))
  return [
    ...marketRequirements,
    ...state.evidenceRequirements
      .filter((requirement) => requirement.kind !== "market_data")
      .map((requirement) => ({ ...requirement, symbols })),
  ].sort((a, b) => a.id.localeCompare(b.id))
}

function semanticIdentity(identity: RequestIdentity) {
  return JSON.stringify({
    symbols: identitySymbols(identity),
    interval: identity.interval?.value,
    assetClass: identity.assetClass?.value,
    algorithmName: identity.algorithmName?.value,
    strategyFamily: identity.strategyFamily?.value,
    window: identity.window?.value,
  })
}

function confirmIdentity(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "identity.confirmed" }>) {
  if (state.identityStatus === "confirmed") {
    return rejected(state, "identity_already_confirmed", "Request identity is already confirmed; use an amendment.")
  }
  if (identitySymbols(event.identity).length === 0) {
    return rejected(state, "identity_symbol_required", "A structured symbol is required to confirm request identity.")
  }
  return {
    ...state,
    identity: event.identity,
    identityStatus: "confirmed" as const,
    phase: "identity_confirmed" as const,
    stage: "evidence_pending" as const,
    status: "active" as const,
    blocker: undefined,
    terminal: undefined,
    evidenceRequirements: requirementsForIdentity(state, event.identity),
  }
}

function amendIdentity(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "identity.amended" }>) {
  if (identitySymbols(event.identity).length === 0) {
    return rejected(state, "identity_symbol_required", "A structured symbol is required to amend request identity.")
  }
  if (semanticIdentity(event.identity) === semanticIdentity(state.identity)) {
    return rejected(state, "identity_unchanged", "The amendment does not change the semantic request identity.")
  }
  const requestVersion = state.requestVersion + 1
  const invalidation = {
    requestVersion,
    reason: event.reason,
    evidenceIds: state.evidence.map((item) => item.id),
    candidateIds: state.candidate ? [state.candidate.algorithmId] : [],
    backtestIds: state.backtest ? [state.backtest.runId] : [],
    eventId: event.id,
  }
  return {
    ...state,
    identity: event.identity,
    identityStatus: "confirmed" as const,
    requestVersion,
    resumeToken: resumeToken(state.workflowId, requestVersion),
    phase: "identity_confirmed" as const,
    stage: "evidence_pending" as const,
    status: "active" as const,
    blocker: undefined,
    terminal: undefined,
    evidenceRequirements: requirementsForIdentity(state, event.identity),
    evidence: [],
    candidate: undefined,
    backtest: undefined,
    researchFreeze: undefined,
    experimentPlan: undefined,
    experimentAttempts: [],
    invalidations: [...state.invalidations, invalidation],
    approvalChallenges: state.approvalChallenges.map((challenge) =>
      challenge.status === "pending" ? { ...challenge, status: "expired" as const } : challenge,
    ),
  }
}

function evidenceReady(state: BuildWorkflowState, evidence: BuildWorkflowState["evidence"]): boolean {
  return state.evidenceRequirements
    .filter((requirement) => requirement.required)
    .every((requirement) =>
      evidence.some(
        (record) =>
          record.requirementId === requirement.id && record.kind === requirement.kind && record.status === "verified",
      ),
    )
}

function canRecordEvidence(stage: BuildWorkflowState["stage"]): boolean {
  if (stage === "evidence_pending") return true
  if (stage === "evidence_ready") return true
  return false
}

function recordEvidence(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "evidence.recorded" }>) {
  if (!canRecordEvidence(state.stage)) {
    return rejected(
      state,
      "evidence_locked",
      "Evidence cannot change after a candidate is saved; invalidate the candidate before replacing evidence.",
    )
  }
  const requirement = state.evidenceRequirements.find((candidate) => candidate.id === event.evidence.requirementId)
  if (!requirement) return rejected(state, "unknown_evidence_requirement", event.evidence.requirementId)
  if (requirement.kind !== event.evidence.kind) {
    return rejected(
      state,
      "evidence_kind_mismatch",
      `Requirement ${requirement.id} expects ${requirement.kind}, not ${event.evidence.kind}.`,
    )
  }
  const evidence = [...state.evidence.filter((record) => record.id !== event.evidence.id), event.evidence]
  return {
    ...state,
    evidence,
    stage: evidenceReady(state, evidence) ? ("evidence_ready" as const) : ("evidence_pending" as const),
    phase: evidenceReady(state, evidence) ? ("evidence_ready" as const) : state.phase,
  }
}

function freezeResearch(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "research.frozen" }>) {
  if (state.phase !== "evidence_ready" || !evidenceReady(state, state.evidence)) {
    return rejected(state, "research_freeze_not_ready", "Research can freeze only after all required evidence is verified.")
  }
  if (event.freeze.requestVersion !== state.requestVersion) {
    return rejected(state, "research_freeze_version_mismatch", "Research freeze belongs to another request version.")
  }
  const verified = new Set(state.evidence.filter((item) => item.status === "verified").map((item) => item.id))
  if (event.freeze.evidenceIds.some((id) => !verified.has(id))) {
    return rejected(state, "research_freeze_evidence_mismatch", "Research freeze references unverified evidence.")
  }
  return { ...state, phase: "research_frozen" as const, researchFreeze: event.freeze }
}

function saveCandidate(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "candidate.saved" }>) {
  if (state.stage !== "evidence_ready" || state.phase !== "research_frozen" || !state.researchFreeze) {
    return rejected(
      state,
      "evidence_not_ready",
      "A candidate can be saved only after verified evidence is durably frozen.",
    )
  }
  return {
    ...state,
    stage: "candidate_ready" as const,
    phase: "candidate_validated" as const,
    candidate: event.candidate,
    backtest: undefined,
    experimentPlan: undefined,
  }
}

function invalidateCandidate(state: BuildWorkflowState) {
  if (!state.candidate) return rejected(state, "candidate_missing", "No current candidate exists to invalidate.")
  return {
    ...state,
    stage: "evidence_ready" as const,
    phase: state.researchFreeze ? ("research_frozen" as const) : ("evidence_ready" as const),
    candidate: undefined,
    backtest: undefined,
    experimentPlan: undefined,
    approvalChallenges: state.approvalChallenges.map((challenge) =>
      challenge.status === "pending" ? { ...challenge, status: "expired" as const } : challenge,
    ),
  }
}

function bindExperimentPlan(
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "experiment.plan_bound" }>,
) {
  const replacingBlockedExploratory =
    state.phase === "strict_blocked" &&
    state.experimentPlan?.kind === "exploratory" &&
    event.plan.kind === "qualification"
  if ((state.phase !== "candidate_validated" && !replacingBlockedExploratory) || !state.candidate) {
    return rejected(state, "experiment_plan_candidate_required", "An experiment plan requires a validated candidate.")
  }
  if (event.plan.requestVersion !== state.requestVersion || event.plan.candidateId !== state.candidate.algorithmId) {
    return rejected(state, "experiment_plan_identity_mismatch", "Experiment plan does not match the active request and candidate.")
  }
  return { ...state, phase: "experiment_planned" as const, experimentPlan: event.plan }
}

const BACKTEST_START_STAGES: WorkflowStage[] = ["candidate_ready", "backtested", "reviewable", "paper_approved"]

function startBacktest(state: BuildWorkflowState) {
  if (!state.candidate) {
    return rejected(state, "candidate_missing", "A current candidate is required before backtesting.")
  }
  if (!BACKTEST_START_STAGES.includes(state.stage)) {
    return rejected(state, "backtest_not_allowed", `A backtest cannot start from workflow stage ${state.stage}.`)
  }
  if ((state.phase !== "experiment_planned" && state.phase !== "strict_blocked") || !state.experimentPlan) {
    return rejected(state, "experiment_plan_required", "A bound durable experiment plan is required before strict execution.")
  }
  return { ...state, stage: "backtest_running" as const, phase: "strict_running" as const, backtest: undefined }
}

const REQUIRED_BACKTEST_HASHES: Array<keyof BacktestHashes> = [
  "strategyHash",
  "savedConfigHash",
  "effectiveConfigHash",
  "dataHash",
  "manifestHash",
  "engineHash",
  "windowHash",
]

function isRunningBacktest(state: BuildWorkflowState): boolean {
  if (state.stage !== "backtest_running") return false
  return !!state.candidate
}

function candidateHashesMatch(candidate: NonNullable<BuildWorkflowState["candidate"]>, backtest: BacktestRef) {
  if (backtest.strategyHash !== candidate.strategyHash) return false
  if (backtest.configHash !== candidate.configHash) return false
  return true
}

function hashesIncomplete(backtest: BacktestRef): boolean {
  return REQUIRED_BACKTEST_HASHES.some((name) => !backtest.hashes[name]?.trim())
}

function hashFieldMismatch(backtest: BacktestRef): boolean {
  if (backtest.hashes.strategyHash !== backtest.strategyHash) return true
  if (backtest.hashes.savedConfigHash !== backtest.configHash) return true
  if (backtest.hashes.dataHash !== backtest.dataHash) return true
  if (backtest.hashes.engineHash !== backtest.engineHash) return true
  return false
}

function identityHashMismatch(backtest: BacktestRef): boolean {
  return backtest.identityHash !== backtestIdentityHash(backtest.hashes)
}

function backtestCompletionIssue(
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "backtest.completed" }>,
): TransitionDecision | undefined {
  if (!isRunningBacktest(state)) {
    return rejected(
      state,
      "backtest_not_running",
      "A matching running backtest is required before recording completion.",
    )
  }
  if (!candidateHashesMatch(state.candidate!, event.backtest)) {
    return rejected(state, "candidate_hash_mismatch", "The completed run does not match the current candidate hashes.")
  }
  if (hashesIncomplete(event.backtest)) {
    return rejected(state, "backtest_hashes_incomplete", "The completed run is missing one or more required hashes.")
  }
  if (hashFieldMismatch(event.backtest)) {
    return rejected(
      state,
      "backtest_hashes_mismatch",
      "The completed run hash map disagrees with its compatibility fields.",
    )
  }
  if (identityHashMismatch(event.backtest)) {
    return rejected(state, "backtest_identity_hash_mismatch", "The completed run identity hash is not canonical.")
  }
  return undefined
}

function completeBacktest(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "backtest.completed" }>) {
  const issue = backtestCompletionIssue(state, event)
  if (issue) return issue
  const stage = event.backtest.verdict === "recommended_for_paper" ? ("reviewable" as const) : ("backtested" as const)
  return {
    ...state,
    stage,
    phase:
      event.backtest.verdict === "recommended_for_paper" ? ("qualified" as const) : ("candidate_validated" as const),
    backtest: event.backtest,
  }
}

function failBacktest(state: BuildWorkflowState) {
  if (!isRunningBacktest(state)) {
    return rejected(state, "backtest_not_running", "A matching running backtest is required before recording failure.")
  }
  return { ...state, stage: "candidate_ready" as const, phase: "strict_blocked" as const, backtest: undefined }
}

function hasExperimentIdentityField(value: string | undefined): boolean {
  return !!value
}

function experimentIdentityComplete(attempt: ExperimentAttempt): boolean {
  if (!hasExperimentIdentityField(attempt.conceptId)) return false
  if (!hasExperimentIdentityField(attempt.strategyHash)) return false
  if (!hasExperimentIdentityField(attempt.savedConfigHash)) return false
  if (!hasExperimentIdentityField(attempt.datasetHash)) return false
  if (!hasExperimentIdentityField(attempt.windowHash)) return false
  return true
}

function gridTrialsInvalid(gridTrials: number): boolean {
  if (!Number.isInteger(gridTrials)) return true
  return gridTrials < 1
}

function recordExperimentIssue(
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "experiment.recorded" }>,
): TransitionDecision | undefined {
  const attempt = event.attempt
  if (attempt.experimentId !== state.workflowId) {
    return rejected(state, "experiment_id_mismatch", "An experiment attempt must belong to the current workflow.")
  }
  if (!experimentIdentityComplete(attempt)) {
    return rejected(
      state,
      "experiment_identity_incomplete",
      "Experiment attempts require complete concept, strategy, config, dataset, and window hashes.",
    )
  }
  if (gridTrialsInvalid(attempt.gridTrials)) {
    return rejected(state, "experiment_grid_trials_invalid", "Experiment gridTrials must be a positive integer.")
  }
  if (attempt.replayKey !== experimentReplayKey(attempt)) {
    return rejected(state, "experiment_replay_key_mismatch", "The experiment replay key is not canonical.")
  }
  if (state.experimentAttempts.some((item) => item.id === attempt.id)) {
    return rejected(state, "experiment_attempt_exists", `Experiment attempt ${attempt.id} already exists.`)
  }
  return undefined
}

function recordExperiment(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "experiment.recorded" }>) {
  const issue = recordExperimentIssue(state, event)
  if (issue) return issue
  return { ...state, experimentAttempts: [...state.experimentAttempts, event.attempt] }
}

function recordAttempt(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "attempt.recorded" }>) {
  if (event.attempt.requestVersion !== state.requestVersion) {
    return rejected(state, "attempt_request_version_mismatch", "The attempt belongs to a different request version.")
  }
  if (state.attempts.some((attempt) => attempt.idempotencyKey === event.attempt.idempotencyKey)) {
    return rejected(state, "attempt_idempotency_replay", "This attempt idempotency key was already recorded.")
  }
  if (state.identityStatus !== "confirmed" && event.attempt.outcome === "accepted") {
    return rejected(state, "identity_unconfirmed", "Accepted execution attempts require structured identity confirmation.")
  }
  const unchangedBlocker = [...state.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.fingerprint === event.attempt.fingerprint &&
        attempt.lifecycle === "terminal" &&
        (attempt.outcome === "blocked" || attempt.outcome === "rejected" || attempt.outcome === "failed"),
    )
  if (unchangedBlocker) {
    return rejected(
      state,
      "unchanged_blocker_retry_denied",
      `Attempt ${unchangedBlocker.id} already blocked this fingerprint; change ${unchangedBlocker.requiredChanges.join(", ") || "the fingerprinted inputs"}.`,
    )
  }
  return { ...state, attempts: [...state.attempts, event.attempt] }
}

function blockWorkflow(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "workflow.blocked" }>) {
  if (state.blocker?.fingerprint && state.blocker.fingerprint === event.blocker.fingerprint) {
    return rejected(
      state,
      "unchanged_blocker_retry_denied",
      `Blocked fingerprint is unchanged; change ${(state.blocker.requiredChanges ?? []).join(", ") || "the fingerprinted inputs"}.`,
    )
  }
  return {
    ...state,
    attempts:
      event.blocker.code === "workflow_interrupted"
        ? state.attempts.map((attempt) =>
            attempt.lifecycle === "in_progress"
              ? {
                  ...attempt,
                  lifecycle: "terminal" as const,
                  outcome: "failed" as const,
                  blockerCode: "workflow_interrupted",
                  requiredChanges: ["resume or rerun the interrupted operation"],
                }
              : attempt,
          )
        : state.attempts,
    status: "blocked" as const,
    blocker: { ...event.blocker, eventId: event.id },
    phase: state.phase === "strict_running" ? ("strict_blocked" as const) : state.phase,
    terminal: {
      workflowRunId: state.workflowId,
      requestVersion: state.requestVersion,
      phase: state.phase === "strict_running" ? ("strict_blocked" as const) : state.phase,
      classification: "blocked" as const,
      semanticSuccess: false,
      semanticExitCode: 2 as const,
      blockerCode: event.blocker.code,
      resumeToken: state.resumeToken,
      revision: state.revision + 1,
    },
  }
}

function resumeWorkflow(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "workflow.resumed" }>) {
  if (state.status !== "blocked") {
    return rejected(state, "workflow_not_blocked", "Only a blocked workflow can resume.")
  }
  if (state.blocker?.fingerprint && state.blocker.fingerprint === event.changedFingerprint) {
    return rejected(state, "resume_inputs_unchanged", "Resume requires a changed fingerprinted input.")
  }
  return { ...state, status: "active" as const, blocker: undefined, terminal: undefined }
}

function completeWorkflow(state: BuildWorkflowState) {
  if (state.phase !== "qualified") {
    return rejected(state, "workflow_not_qualified", "Only a qualified workflow can complete semantically.")
  }
  return {
    ...state,
    status: "completed" as const,
    phase: "terminal_complete" as const,
    terminal: {
      workflowRunId: state.workflowId,
      requestVersion: state.requestVersion,
      phase: "terminal_complete" as const,
      classification: "complete" as const,
      semanticSuccess: true,
      semanticExitCode: 0 as const,
      resumeToken: state.resumeToken,
      revision: state.revision + 1,
    },
  }
}

function failWorkflow(state: BuildWorkflowState) {
  return {
    ...state,
    status: "failed" as const,
    phase: "terminal_failed" as const,
    terminal: {
      workflowRunId: state.workflowId,
      requestVersion: state.requestVersion,
      phase: "terminal_failed" as const,
      classification: "failed" as const,
      semanticSuccess: false,
      semanticExitCode: 3 as const,
      resumeToken: state.resumeToken,
      revision: state.revision + 1,
    },
  }
}

type EventHandler = (state: BuildWorkflowState, event: WorkflowEvent) => BuildWorkflowState | TransitionDecision

const EVENT_HANDLERS: Record<WorkflowEvent["type"], EventHandler> = {
  "identity.confirmed": (state, event) =>
    confirmIdentity(state, event as Extract<WorkflowEvent, { type: "identity.confirmed" }>),
  "identity.amended": (state, event) =>
    amendIdentity(state, event as Extract<WorkflowEvent, { type: "identity.amended" }>),
  "evidence.recorded": (state, event) =>
    recordEvidence(state, event as Extract<WorkflowEvent, { type: "evidence.recorded" }>),
  "research.frozen": (state, event) =>
    freezeResearch(state, event as Extract<WorkflowEvent, { type: "research.frozen" }>),
  "candidate.saved": (state, event) =>
    saveCandidate(state, event as Extract<WorkflowEvent, { type: "candidate.saved" }>),
  "candidate.invalidated": (state) => invalidateCandidate(state),
  "experiment.plan_bound": (state, event) =>
    bindExperimentPlan(state, event as Extract<WorkflowEvent, { type: "experiment.plan_bound" }>),
  "backtest.started": (state) => startBacktest(state),
  "backtest.failed": (state) => failBacktest(state),
  "backtest.completed": (state, event) =>
    completeBacktest(state, event as Extract<WorkflowEvent, { type: "backtest.completed" }>),
  "approval.requested": (state, event) =>
    requestApproval(state, event as Extract<WorkflowEvent, { type: "approval.requested" }>),
  "approval.granted": (state, event) =>
    grantApproval(state, event as Extract<WorkflowEvent, { type: "approval.granted" }>),
  "approval.rejected": (state, event) =>
    rejectApproval(state, event as Extract<WorkflowEvent, { type: "approval.rejected" }>),
  "experiment.recorded": (state, event) =>
    recordExperiment(state, event as Extract<WorkflowEvent, { type: "experiment.recorded" }>),
  "attempt.recorded": (state, event) =>
    recordAttempt(state, event as Extract<WorkflowEvent, { type: "attempt.recorded" }>),
  "workflow.blocked": (state, event) =>
    blockWorkflow(state, event as Extract<WorkflowEvent, { type: "workflow.blocked" }>),
  "workflow.resumed": (state, event) =>
    resumeWorkflow(state, event as Extract<WorkflowEvent, { type: "workflow.resumed" }>),
  "workflow.completed": (state) => completeWorkflow(state),
  "workflow.failed": (state) => failWorkflow(state),
}

export function applyEvent(state: BuildWorkflowState, event: WorkflowEvent): BuildWorkflowState | TransitionDecision {
  return EVENT_HANDLERS[event.type](state, event)
}

const BLOCKED_ALLOWED_EVENTS = new Set([
  "workflow.resumed",
  "identity.confirmed",
  "identity.amended",
  "approval.granted",
  "approval.rejected",
])

function blockedEventDenied(status: BuildWorkflowState["status"], eventType: WorkflowEvent["type"]): boolean {
  if (status !== "blocked") return false
  return !BLOCKED_ALLOWED_EVENTS.has(eventType)
}

function terminalEventDenied(status: BuildWorkflowState["status"], eventType: WorkflowEvent["type"]): boolean {
  if (eventType === "workflow.blocked") return false
  if (status === "completed") return true
  if (status === "failed") return true
  if (status === "superseded") return true
  return false
}

const PROPOSED_IDENTITY_ALLOWED_EVENTS = new Set<WorkflowEvent["type"]>([
  "identity.confirmed",
  "identity.amended",
  "attempt.recorded",
  "workflow.blocked",
  "workflow.failed",
])

export function preTransitionIssue(state: BuildWorkflowState, event: WorkflowEvent): TransitionDecision | undefined {
  if (state.identityStatus !== "confirmed" && !PROPOSED_IDENTITY_ALLOWED_EVENTS.has(event.type)) {
    return rejected(
      state,
      "identity_unconfirmed",
      "Structured request identity confirmation is required before lifecycle advancement.",
    )
  }
  if (blockedEventDenied(state.status, event.type)) {
    return rejected(state, "workflow_blocked", state.blocker?.message ?? "The workflow is blocked.")
  }
  if (terminalEventDenied(state.status, event.type)) {
    return rejected(state, "workflow_terminal", `The workflow is ${state.status}.`)
  }
  return undefined
}

export function transition(state: BuildWorkflowState, event: WorkflowEvent): TransitionDecision {
  const guard = preTransitionIssue(state, event)
  if (guard) return guard
  const applied = applyEvent(state, event)
  if ("allowed" in applied) return applied
  return {
    allowed: true,
    code: "transition_applied",
    state: {
      ...applied,
      revision: state.revision + 1,
      updatedAt: event.occurredAt,
    },
  }
}
