import {
  grantApproval,
  rejectApproval,
  requestApproval,
} from "./state-approvals"
import {
  backtestIdentityHash,
  experimentReplayKey,
} from "./state-identity"
import type {
  BacktestHashes,
  BacktestRef,
  BuildWorkflowState,
  ExperimentAttempt,
  TransitionDecision,
  WorkflowEvent,
  WorkflowStage,
} from "./types"

function rejected(state: BuildWorkflowState, code: string, message: string): TransitionDecision {
  return { allowed: false, code, message, state }
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
  }
}

function saveCandidate(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "candidate.saved" }>) {
  if (state.stage !== "evidence_ready") {
    return rejected(
      state,
      "evidence_not_ready",
      "A candidate can be saved only after every required evidence item is verified.",
    )
  }
  return { ...state, stage: "candidate_ready" as const, candidate: event.candidate, backtest: undefined }
}

function invalidateCandidate(state: BuildWorkflowState) {
  if (!state.candidate) return rejected(state, "candidate_missing", "No current candidate exists to invalidate.")
  return {
    ...state,
    stage: "evidence_ready" as const,
    candidate: undefined,
    backtest: undefined,
    approvalChallenges: state.approvalChallenges.map((challenge) =>
      challenge.status === "pending" ? { ...challenge, status: "expired" as const } : challenge,
    ),
  }
}

const BACKTEST_START_STAGES: WorkflowStage[] = ["candidate_ready", "backtested", "reviewable", "paper_approved"]

function startBacktest(state: BuildWorkflowState) {
  if (!state.candidate) {
    return rejected(state, "candidate_missing", "A current candidate is required before backtesting.")
  }
  if (!BACKTEST_START_STAGES.includes(state.stage)) {
    return rejected(state, "backtest_not_allowed", `A backtest cannot start from workflow stage ${state.stage}.`)
  }
  return { ...state, stage: "backtest_running" as const, backtest: undefined }
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
    return rejected(state, "backtest_hashes_mismatch", "The completed run hash map disagrees with its compatibility fields.")
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
  return { ...state, stage, backtest: event.backtest }
}

function failBacktest(state: BuildWorkflowState) {
  if (!isRunningBacktest(state)) {
    return rejected(state, "backtest_not_running", "A matching running backtest is required before recording failure.")
  }
  return { ...state, stage: "candidate_ready" as const, backtest: undefined }
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

function blockWorkflow(state: BuildWorkflowState, event: Extract<WorkflowEvent, { type: "workflow.blocked" }>) {
  return {
    ...state,
    status: "blocked" as const,
    blocker: { ...event.blocker, eventId: event.id },
  }
}

function resumeWorkflow(state: BuildWorkflowState) {
  if (state.status !== "blocked") {
    return rejected(state, "workflow_not_blocked", "Only a blocked workflow can resume.")
  }
  return { ...state, status: "active" as const, blocker: undefined }
}

type EventHandler = (
  state: BuildWorkflowState,
  event: WorkflowEvent,
) => BuildWorkflowState | TransitionDecision

const EVENT_HANDLERS: Record<WorkflowEvent["type"], EventHandler> = {
  "evidence.recorded": (state, event) => recordEvidence(state, event as Extract<WorkflowEvent, { type: "evidence.recorded" }>),
  "candidate.saved": (state, event) => saveCandidate(state, event as Extract<WorkflowEvent, { type: "candidate.saved" }>),
  "candidate.invalidated": (state) => invalidateCandidate(state),
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
  "workflow.blocked": (state, event) => blockWorkflow(state, event as Extract<WorkflowEvent, { type: "workflow.blocked" }>),
  "workflow.resumed": (state) => resumeWorkflow(state),
}

export function applyEvent(state: BuildWorkflowState, event: WorkflowEvent): BuildWorkflowState | TransitionDecision {
  return EVENT_HANDLERS[event.type](state, event)
}

const BLOCKED_ALLOWED_EVENTS = new Set(["workflow.resumed", "approval.granted", "approval.rejected"])

function blockedEventDenied(status: BuildWorkflowState["status"], eventType: WorkflowEvent["type"]): boolean {
  if (status !== "blocked") return false
  return !BLOCKED_ALLOWED_EVENTS.has(eventType)
}

function terminalEventDenied(status: BuildWorkflowState["status"], eventType: WorkflowEvent["type"]): boolean {
  if (eventType === "workflow.blocked") return false
  if (status === "completed") return true
  if (status === "superseded") return true
  return false
}

export function preTransitionIssue(
  state: BuildWorkflowState,
  event: WorkflowEvent,
): TransitionDecision | undefined {
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
