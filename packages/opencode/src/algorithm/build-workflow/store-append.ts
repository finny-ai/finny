import {
  AlgorithmBuildApprovalChallengeTable,
  AlgorithmBuildWorkflowEventTable,
  AlgorithmBuildWorkflowTable,
} from "@opencode-ai/core/algorithm/build-workflow-schema"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { isBuildWorkflowState, transition, unambiguousApprovalDecision } from "./state"
import type {
  ApplyStoredEventResult,
  ApprovalChallenge,
  ApprovalKind,
  ApprovalScope,
  ApprovalStatus,
  BuildWorkflowState,
  WorkflowEvent,
} from "./types"
import { WorkflowStateCorruptError } from "./store-errors"

type Tx = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

function encode(input: object): Record<string, unknown> {
  return input as Record<string, unknown>
}

export function decodeState(workflowId: string, input: unknown): BuildWorkflowState {
  if (!isBuildWorkflowState(input)) throw new WorkflowStateCorruptError({ workflowId })
  return input
}

export function rowToChallenge(row: typeof AlgorithmBuildApprovalChallengeTable.$inferSelect): ApprovalChallenge {
  return {
    id: row.id,
    kind: row.kind as ApprovalKind,
    scopeHash: row.scope_hash,
    scope: row.scope as ApprovalScope,
    status: row.status as ApprovalStatus,
    reason: row.reason,
    createdAt: row.time_created,
    sourceMessageId: row.source_message_id ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
  }
}

function insertChallengeRow(tx: Tx, state: BuildWorkflowState, challenge: ApprovalChallenge) {
  return tx
    .insert(AlgorithmBuildApprovalChallengeTable)
    .values({
      id: challenge.id,
      workflow_id: state.workflowId,
      kind: challenge.kind,
      scope_hash: challenge.scopeHash,
      scope: challenge.scope,
      status: challenge.status,
      reason: challenge.reason,
      time_created: challenge.createdAt,
      time_updated: challenge.createdAt,
    })
    .run()
}

function updateResolvedChallenge(
  tx: Tx,
  state: BuildWorkflowState,
  challenge: ApprovalChallenge,
  occurredAt: number,
) {
  return tx
    .update(AlgorithmBuildApprovalChallengeTable)
    .set({
      status: challenge.status,
      source_message_id: challenge.sourceMessageId ?? null,
      resolved_at: challenge.resolvedAt ?? null,
      time_updated: occurredAt,
    })
    .where(
      and(
        eq(AlgorithmBuildApprovalChallengeTable.workflow_id, state.workflowId),
        eq(AlgorithmBuildApprovalChallengeTable.id, challenge.id),
      ),
    )
    .run()
}

function expirePendingChallenges(tx: Tx, state: BuildWorkflowState, occurredAt: number) {
  return tx
    .update(AlgorithmBuildApprovalChallengeTable)
    .set({ status: "expired", resolved_at: occurredAt, time_updated: occurredAt })
    .where(
      and(
        eq(AlgorithmBuildApprovalChallengeTable.workflow_id, state.workflowId),
        eq(AlgorithmBuildApprovalChallengeTable.status, "pending"),
      ),
    )
    .run()
}

export function persistChallengeEvent(tx: Tx, state: BuildWorkflowState, event: WorkflowEvent) {
  if (event.type === "approval.requested") {
    const challenge = state.approvalChallenges.find((candidate) => candidate.id === event.challenge.id)!
    return insertChallengeRow(tx, state, challenge)
  }
  if (event.type === "approval.granted" || event.type === "approval.rejected") {
    const challenge = state.approvalChallenges.find((candidate) => candidate.id === event.challengeId)!
    return updateResolvedChallenge(tx, state, challenge, event.occurredAt)
  }
  if (event.type === "candidate.invalidated") {
    return expirePendingChallenges(tx, state, event.occurredAt)
  }
  return Effect.void
}

function isStructuredApprovalSource(
  event: Extract<WorkflowEvent, { type: "approval.granted" | "approval.rejected" }>,
) {
  if (event.source.actor !== "user") return false
  if (event.source.synthetic === true) return false
  if (event.source.structuredResponse !== true) return false
  return !!event.source.questionRequestId
}

function solePendingChallenge(
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "approval.granted" | "approval.rejected" }>,
) {
  const challenge = state.approvalChallenges.find((candidate) => candidate.id === event.challengeId)
  const pending = state.approvalChallenges.filter((candidate) => candidate.status === "pending")
  if (!challenge) return undefined
  if (pending.length !== 1) return undefined
  if (pending[0]?.id !== challenge.id) return undefined
  return challenge
}

function approvalTextMatches(
  text: string,
  event: Extract<WorkflowEvent, { type: "approval.granted" | "approval.rejected" }>,
) {
  const decision = unambiguousApprovalDecision(text)
  if (event.type === "approval.granted") return decision === "approve"
  return decision === "reject"
}

function messageTextParts(parts: Array<{ data: unknown }>) {
  return parts
    .map((part) => part.data as { type?: string; synthetic?: boolean; text?: string })
    .filter((part) => part.type === "text" && part.synthetic !== true && !!part.text?.trim())
    .map((part) => part.text!.trim())
    .join("\n")
}

function messageTimingValid(
  messageTime: number,
  challengeCreatedAt: number,
  eventOccurredAt: number,
) {
  if (messageTime < challengeCreatedAt) return false
  if (eventOccurredAt < messageTime) return false
  return true
}

function isPersistedUserTextSource(
  event: Extract<WorkflowEvent, { type: "approval.granted" | "approval.rejected" }>,
): event is Extract<WorkflowEvent, { type: "approval.granted" | "approval.rejected" }> & {
  source: { actor: "user"; messageId: string; synthetic?: false }
} {
  if (event.source.actor !== "user") return false
  if (event.source.synthetic === true) return false
  return !!event.source.messageId
}

function isUserRoleMessage(message: { data: { role?: string } } | undefined): message is { data: { role: "user" }; time_created: number } {
  if (!message) return false
  return message.data.role === "user"
}

export function persistedUserApprovalSource(
  tx: Tx,
  state: BuildWorkflowState,
  event: Extract<WorkflowEvent, { type: "approval.granted" | "approval.rejected" }>,
) {
  return Effect.gen(function* () {
    if (isStructuredApprovalSource(event)) return true
    if (!isPersistedUserTextSource(event)) return false
    const challenge = solePendingChallenge(state, event)
    if (!challenge) return false
    const messageId = event.source.messageId as (typeof MessageTable.$inferSelect)["id"]
    const sessionId = state.sessionId as (typeof MessageTable.$inferSelect)["session_id"]
    const message = yield* tx
      .select()
      .from(MessageTable)
      .where(and(eq(MessageTable.id, messageId), eq(MessageTable.session_id, sessionId)))
      .get()
    if (!isUserRoleMessage(message)) return false
    if (!messageTimingValid(message.time_created, challenge.createdAt, event.occurredAt)) return false
    const parts = yield* tx.select().from(PartTable).where(eq(PartTable.message_id, messageId)).all()
    return approvalTextMatches(messageTextParts(parts), event)
  })
}

function revisionConflictResult(
  workflowId: string,
  expectedRevision: number,
  actualRevision: number,
): ApplyStoredEventResult {
  return {
    kind: "revision_conflict",
    workflowId,
    expectedRevision,
    actualRevision,
  }
}

function unprovenApprovalResult(current: BuildWorkflowState): ApplyStoredEventResult {
  return {
    kind: "rejected",
    decision: {
      allowed: false,
      code: "approval_source_not_persisted_user",
      message: "Approval must reference a persisted non-synthetic user text message in this workflow session.",
      state: current,
    },
  }
}

function isApprovalDecisionEvent(event: WorkflowEvent): event is Extract<
  WorkflowEvent,
  { type: "approval.granted" | "approval.rejected" }
> {
  return event.type === "approval.granted" || event.type === "approval.rejected"
}

function persistAppliedTransition(
  tx: Tx,
  workflowId: string,
  event: WorkflowEvent,
  decision: Extract<ReturnType<typeof transition>, { allowed: true }>,
) {
  return Effect.gen(function* () {
    yield* tx
      .update(AlgorithmBuildWorkflowTable)
      .set({
        stage: decision.state.stage,
        status: decision.state.status,
        revision: decision.state.revision,
        state: encode(decision.state),
        time_updated: decision.state.updatedAt,
      })
      .where(eq(AlgorithmBuildWorkflowTable.id, workflowId))
      .run()
    yield* tx
      .insert(AlgorithmBuildWorkflowEventTable)
      .values({
        id: event.id,
        workflow_id: workflowId,
        seq: decision.state.revision,
        type: event.type,
        payload: encode(event),
        source_kind: event.source.actor,
        source_message_id: event.source.messageId,
        time_created: event.occurredAt,
      })
      .run()
    yield* persistChallengeEvent(tx, decision.state, event)
    return { kind: "applied" as const, decision }
  })
}

export function appendInTransaction(
  tx: Tx,
  input: {
    workflowId: string
    event: WorkflowEvent
    expectedRevision?: number
  },
) {
  return Effect.gen(function* () {
    const row = yield* tx
      .select()
      .from(AlgorithmBuildWorkflowTable)
      .where(eq(AlgorithmBuildWorkflowTable.id, input.workflowId))
      .get()
    if (!row) return { kind: "not_found" as const, workflowId: input.workflowId }

    const current = decodeState(row.id, row.state)
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
      return revisionConflictResult(input.workflowId, input.expectedRevision, current.revision)
    }
    if (isApprovalDecisionEvent(input.event)) {
      const proven = yield* persistedUserApprovalSource(tx, current, input.event)
      if (!proven) return unprovenApprovalResult(current)
    }

    const decision = transition(current, input.event)
    if (!decision.allowed) return { kind: "rejected" as const, decision }
    return yield* persistAppliedTransition(tx, input.workflowId, input.event, decision)
  })
}
