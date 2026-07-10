export const WORKFLOW_SCHEMA_VERSION = 1 as const

export const WORKFLOW_STAGES = [
  "request_bound",
  "evidence_pending",
  "evidence_ready",
  "candidate_ready",
  "backtest_running",
  "backtested",
  "reviewable",
  "paper_approved",
] as const

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number]
export type WorkflowStatus = "active" | "blocked" | "completed" | "superseded"
export type WorkflowIntent = "build" | "update" | "research"
export type EvidenceKind = "market_data" | "news" | "sec" | "sentiment"
export type EvidenceStatus = "verified" | "blocked" | "unusable"
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired"
export type WorkflowActorKind = "user" | "assistant" | "tool" | "system" | "subagent"

export type ApprovalKind =
  | "extended_data_window"
  | "provider_change"
  | "interval_change"
  | "repair_outliers"
  | "concept_pivot"
  | "failure_budget_override"
  | "version_bump"
  | "paper_trading"

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type ApprovalScope = Record<string, JsonValue>

export interface UserMessageFactSource {
  kind: "user_message"
  messageId: string
}

export interface DelegatedDefaultFactSource {
  kind: "delegated_default"
  messageId: string
  policy: string
}

export interface PolicyDefaultFactSource {
  kind: "policy_default"
  policy: string
}

export interface LegacyImportFactSource {
  kind: "legacy_import"
  path: string
}

export type FactSource =
  | UserMessageFactSource
  | DelegatedDefaultFactSource
  | PolicyDefaultFactSource
  | LegacyImportFactSource

export interface Provenanced<T> {
  value: T
  source: FactSource
}

export interface DateWindow {
  start: string
  end: string
}

export interface RequestIdentity {
  symbols?: Provenanced<string[]>
  interval?: Provenanced<string>
  assetClass?: Provenanced<string>
  algorithmName?: Provenanced<string>
  strategyFamily?: Provenanced<string>
  window?: Provenanced<DateWindow>
}

export interface EvidencePolicyInput {
  intent: WorkflowIntent
  identity: RequestIdentity
  newsRequired?: boolean
  filingDependent?: boolean
  sentimentRequired?: boolean
  marketDataRequired?: boolean
}

export interface EvidenceRequirement {
  id: string
  kind: EvidenceKind
  required: boolean
  symbols: string[]
  reason: string
}

export interface EvidenceRecord {
  id: string
  requirementId: string
  kind: EvidenceKind
  status: EvidenceStatus
  artifactId?: string
  runId?: string
  sourceSessionId?: string
  verifiedAt?: number
  issues: string[]
}

export interface CandidateRef {
  algorithmId: string
  name: string
  version: number
  strategyHash: string
  configHash: string
  conceptId: string
}

/**
 * Hashes that bind a completed strict run to the bytes and configuration that
 * produced it. The index signature is intentional: later integrity schemas
 * can add document, risk-contract, execution-profile, and engine-tree hashes
 * without weakening the controller identity.
 */
export interface BacktestHashes {
  strategyHash: string
  savedConfigHash: string
  effectiveConfigHash: string
  dataHash: string
  manifestHash: string
  engineHash: string
  windowHash: string
  [name: string]: string
}

export interface BacktestRef {
  runId: string
  strategyHash: string
  configHash: string
  dataHash: string
  engineHash: string
  hashes: BacktestHashes
  /** Canonical hash of every named entry in `hashes`; extensible by design. */
  identityHash: string
  verdict: "failed" | "research_only" | "candidate" | "recommended_for_paper"
}

export interface WorkflowBlocker {
  code: string
  message: string
  eventId: string
}

export interface ApprovalChallenge {
  id: string
  kind: ApprovalKind
  scopeHash: string
  scope: ApprovalScope
  status: ApprovalStatus
  reason: string
  createdAt: number
  sourceMessageId?: string
  resolvedAt?: number
}

export interface ApprovalRecord {
  challengeId: string
  kind: ApprovalKind
  scopeHash: string
  sourceMessageId?: string
  questionRequestId?: string
  grantedAt: number
}

export interface ConceptDefinition {
  symbol: string
  assetClass: string
  interval: string
  strategyFamily: string
  direction: string
  entryRules: string
  exitRules: string
}

export type ExperimentAttemptOutcome = "metrics" | "setup_failure" | "engine_failure"

/**
 * An append-only experiment observation. `experimentId` is always the owning
 * workflow id. Algorithm names are deliberately absent from both identity
 * hashes so renaming a candidate cannot reset selection history.
 */
export interface ExperimentAttempt {
  id: string
  experimentId: string
  conceptId: string
  replayKey: string
  strategyHash: string
  savedConfigHash: string
  datasetHash: string
  windowHash: string
  gridTrials: number
  outcome: ExperimentAttemptOutcome
  runId?: string
  createdAt: number
}

export interface ExperimentTrialSummary {
  experimentId: string
  conceptId: string
  priorUniqueTrials: number
  currentGridTrials: number
  totalDsrTrials: number
  remainingTrials: number
  replayOfAttemptId?: string
  budgetExceeded: boolean
}

export interface WorkflowEventSource {
  actor: WorkflowActorKind
  messageId?: string
  questionRequestId?: string
  structuredResponse?: boolean
  synthetic?: boolean
}

interface EventEnvelope {
  id: string
  occurredAt: number
  source: WorkflowEventSource
}

export type WorkflowEvent =
  | (EventEnvelope & { type: "evidence.recorded"; evidence: EvidenceRecord })
  | (EventEnvelope & { type: "candidate.saved"; candidate: CandidateRef })
  | (EventEnvelope & { type: "candidate.invalidated"; reason: string })
  | (EventEnvelope & { type: "backtest.started" })
  | (EventEnvelope & { type: "backtest.failed"; reason: string })
  | (EventEnvelope & { type: "backtest.completed"; backtest: BacktestRef })
  | (EventEnvelope & { type: "approval.requested"; challenge: ApprovalChallenge })
  | (EventEnvelope & { type: "approval.granted"; challengeId: string; scopeHash: string })
  | (EventEnvelope & { type: "approval.rejected"; challengeId: string })
  | (EventEnvelope & { type: "experiment.recorded"; attempt: ExperimentAttempt })
  | (EventEnvelope & { type: "workflow.blocked"; blocker: Omit<WorkflowBlocker, "eventId"> })
  | (EventEnvelope & { type: "workflow.resumed" })

export interface BuildWorkflowState {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION
  workflowId: string
  sessionId: string
  workspaceSlug: string
  intent: WorkflowIntent
  stage: WorkflowStage
  status: WorkflowStatus
  revision: number
  identity: RequestIdentity
  evidenceRequirements: EvidenceRequirement[]
  evidence: EvidenceRecord[]
  approvalChallenges: ApprovalChallenge[]
  approvals: ApprovalRecord[]
  experimentAttempts: ExperimentAttempt[]
  candidate?: CandidateRef
  backtest?: BacktestRef
  blocker?: WorkflowBlocker
  createdAt: number
  updatedAt: number
}

export interface CreateBuildWorkflowInput extends EvidencePolicyInput {
  workflowId: string
  sessionId: string
  workspaceSlug: string
  now?: number
}

export type TransitionDecision =
  | { allowed: true; code: "transition_applied"; state: BuildWorkflowState }
  | { allowed: false; code: string; message: string; state: BuildWorkflowState }

export interface StoredWorkflowEvent {
  id: string
  workflowId: string
  seq: number
  type: "workflow.created" | WorkflowEvent["type"]
  payload: Record<string, unknown>
  source: WorkflowEventSource
  occurredAt: number
}

export type ApplyStoredEventResult =
  | { kind: "applied"; decision: Extract<TransitionDecision, { allowed: true }> }
  | { kind: "rejected"; decision: Extract<TransitionDecision, { allowed: false }> }
  | { kind: "not_found"; workflowId: string }
  | { kind: "revision_conflict"; workflowId: string; expectedRevision: number; actualRevision: number }

export interface RequestJsonProjection {
  schema_version: 1
  source_of_truth: "algorithm_build_workflow"
  workflow_id: string
  workflow_revision: number
  workflow_stage: WorkflowStage
  request_id: string
  requested_symbol?: string
  requested_symbols?: string[]
  requested_interval?: string
  requested_asset_class?: string
  requested_algorithm_name?: string
  requested_strategy_family?: string
  requested_start?: string
  requested_end?: string
  provenance: Record<string, FactSource>
  updated: string
}

export * as BuildWorkflowTypes from "./types"
