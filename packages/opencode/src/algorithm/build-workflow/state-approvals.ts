import crypto from "node:crypto"
import {
  type ApprovalChallenge,
  type ApprovalKind,
  type ApprovalScope,
  type BacktestRef,
  type BuildWorkflowState,
  type TransitionDecision,
  type WorkflowEvent,
} from "./types"

function rejected(state: BuildWorkflowState, code: string, message: string): TransitionDecision {
  return { allowed: false, code, message, state }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function approvalScopeHash(kind: ApprovalKind, scope: ApprovalScope): string {
  return crypto.createHash("sha256").update(canonicalJson({ kind, scope })).digest("hex")
}

export function paperTradingApprovalScope(backtest: BacktestRef): ApprovalScope {
  return {
    runId: backtest.runId,
    strategyHash: backtest.strategyHash,
    configHash: backtest.configHash,
    dataHash: backtest.dataHash,
    engineHash: backtest.engineHash,
    hashes: backtest.hashes,
    identityHash: backtest.identityHash,
  }
}

export function makeApprovalChallenge(input: {
  id: string
  kind: ApprovalKind
  scope: ApprovalScope
  reason: string
  now?: number
}): ApprovalChallenge {
  return {
    id: input.id,
    kind: input.kind,
    scope: input.scope,
    scopeHash: approvalScopeHash(input.kind, input.scope),
    status: "pending",
    reason: input.reason,
    createdAt: input.now ?? Date.now(),
  }
}

export function unambiguousApprovalDecision(text: string): "approve" | "reject" | undefined {
  const approves = /\bapprove(?:d|s)?\b/i.test(text)
  const rejects = /\b(reject(?:ed|s)?|deny|denied|decline(?:d|s)?)\b/i.test(text)
  if (approves === rejects) return undefined
  return approves ? "approve" : "reject"
}

function realUserSource(event: Extract<WorkflowEvent, { type: "approval.granted" | "approval.rejected" }>) {
  if (event.source.actor !== "user" || event.source.synthetic === true) return false
  if (event.source.structuredResponse === true) return !!event.source.questionRequestId
  return !!event.source.messageId
}

function baseApprovalRequestIssue(
  state: BuildWorkflowState,
  challenge: ApprovalChallenge,
): TransitionDecision | undefined {
  if (state.approvalChallenges.some((item) => item.id === challenge.id)) {
    return rejected(state, "approval_challenge_exists", `Approval challenge ${challenge.id} already exists.`)
  }
  if (challenge.status !== "pending") {
    return rejected(state, "approval_challenge_not_pending", "A new approval challenge must start in pending state.")
  }
  const expectedHash = approvalScopeHash(challenge.kind, challenge.scope)
  if (challenge.scopeHash !== expectedHash) {
    return rejected(state, "approval_scope_hash_mismatch", "The approval challenge scope hash is not canonical.")
  }
  return undefined
}

function hasPaperBacktestIdentity(backtest: BuildWorkflowState["backtest"]): backtest is NonNullable<BuildWorkflowState["backtest"]> {
  if (!backtest) return false
  if (!backtest.dataHash) return false
  if (!backtest.engineHash) return false
  if (!backtest.identityHash) return false
  return true
}

function paperApprovalRequestIssue(
  state: BuildWorkflowState,
  challenge: ApprovalChallenge,
): TransitionDecision | undefined {
  if (state.stage !== "reviewable") {
    return rejected(
      state,
      "paper_approval_not_reviewable",
      "Paper approval can be requested only for a reviewable run.",
    )
  }
  if (!hasPaperBacktestIdentity(state.backtest)) {
    return rejected(
      state,
      "paper_approval_identity_incomplete",
      "Paper approval requires the canonical full-hash identity from the reviewable run.",
    )
  }
  const expectedScope = paperTradingApprovalScope(state.backtest)
  if (challenge.scopeHash !== approvalScopeHash("paper_trading", expectedScope)) {
    return rejected(
      state,
      "paper_approval_scope_mismatch",
      "Paper approval must bind the exact current run and all immutable hashes.",
    )
  }
  return undefined
}

export function requestApproval(
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "approval.requested" }>,
) {
  const baseIssue = baseApprovalRequestIssue(state, event.challenge)
  if (baseIssue) return baseIssue
  if (event.challenge.kind === "paper_trading") {
    const paperIssue = paperApprovalRequestIssue(state, event.challenge)
    if (paperIssue) return paperIssue
  }
  return {
    ...state,
    approvalChallenges: [
      ...state.approvalChallenges,
      { ...event.challenge, createdAt: event.occurredAt, sourceMessageId: undefined },
    ],
  }
}

function pendingChallenge(
  state: BuildWorkflowState,
  challengeId: string,
): { index: number; challenge: ApprovalChallenge } | TransitionDecision {
  const index = state.approvalChallenges.findIndex((item) => item.id === challengeId)
  const challenge = state.approvalChallenges[index]
  if (!challenge) return rejected(state, "approval_challenge_missing", `Approval challenge ${challengeId} was not found.`)
  if (challenge.status !== "pending") {
    return rejected(state, "approval_challenge_resolved", `Approval challenge ${challengeId} is ${challenge.status}.`)
  }
  return { index, challenge }
}

function grantApprovalIssue(
  state: BuildWorkflowState,
  challenge: ApprovalChallenge,
  event: Extract<WorkflowEvent, { type: "approval.granted" }>,
): TransitionDecision | undefined {
  if (event.occurredAt < challenge.createdAt) {
    return rejected(state, "approval_precedes_challenge", "Approval cannot precede its challenge.")
  }
  if (event.scopeHash !== challenge.scopeHash) {
    return rejected(state, "approval_scope_mismatch", "Approval does not match the pending challenge scope.")
  }
  if (challenge.kind === "paper_trading" && state.stage !== "reviewable") {
    return rejected(state, "paper_approval_not_reviewable", "The current workflow is no longer reviewable.")
  }
  return undefined
}

function applyGrantedApproval(
  state: BuildWorkflowState,
  found: { index: number; challenge: ApprovalChallenge },
  event: Extract<WorkflowEvent, { type: "approval.granted" }>,
): BuildWorkflowState {
  const sourceMessageId = event.source.messageId
  const questionRequestId = event.source.questionRequestId
  const approvalChallenges = [...state.approvalChallenges]
  approvalChallenges[found.index] = {
    ...found.challenge,
    status: "approved",
    sourceMessageId,
    resolvedAt: event.occurredAt,
  }
  return {
    ...state,
    stage: found.challenge.kind === "paper_trading" ? ("paper_approved" as const) : state.stage,
    approvalChallenges,
    approvals: [
      ...state.approvals,
      {
        challengeId: found.challenge.id,
        kind: found.challenge.kind,
        scopeHash: found.challenge.scopeHash,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(questionRequestId ? { questionRequestId } : {}),
        grantedAt: event.occurredAt,
      },
    ],
  }
}

export function grantApproval(
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "approval.granted" }>,
) {
  if (!realUserSource(event)) {
    return rejected(state, "approval_source_not_user", "Only a non-synthetic user message can grant approval.")
  }
  const found = pendingChallenge(state, event.challengeId)
  if ("allowed" in found) return found
  const issue = grantApprovalIssue(state, found.challenge, event)
  if (issue) return issue
  return applyGrantedApproval(state, found, event)
}

export function rejectApproval(
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "approval.rejected" }>,
) {
  if (!realUserSource(event)) {
    return rejected(state, "approval_source_not_user", "Only a non-synthetic user message can reject approval.")
  }
  const found = pendingChallenge(state, event.challengeId)
  if ("allowed" in found) return found
  const approvalChallenges = [...state.approvalChallenges]
  approvalChallenges[found.index] = {
    ...found.challenge,
    status: "rejected",
    sourceMessageId: event.source.messageId,
    resolvedAt: event.occurredAt,
  }
  return { ...state, approvalChallenges }
}
