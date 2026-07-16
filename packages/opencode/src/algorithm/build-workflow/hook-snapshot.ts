import type {
  ApprovalKind,
  BuildWorkflowState,
  EvidenceKind,
  WorkflowRunPhase,
  WorkflowStage,
  WorkflowStatus,
  WorkflowTerminalClassification,
} from "./types"

const MAX_PENDING = 10
const MAX_SESSIONS = 256

export interface WorkflowHookSnapshot {
  workflowId: string
  sessionId: string
  revision: number
  stage: WorkflowStage
  phase: WorkflowRunPhase
  status: WorkflowStatus
  requestVersion: number
  resumeToken: string
  blockerCode?: string
  terminalClassification?: WorkflowTerminalClassification
  pendingEvidence: Array<{ id: string; kind: EvidenceKind }>
  pendingApprovals: Array<{ id: string; kind: ApprovalKind }>
}

const latestBySession = new Map<string, WorkflowHookSnapshot>()

export function workflowHookSnapshotFromState(state: BuildWorkflowState): WorkflowHookSnapshot {
  const verified = new Set(
    state.evidence.filter((item) => item.status === "verified").map((item) => item.requirementId),
  )
  return {
    workflowId: state.workflowId,
    sessionId: state.sessionId,
    revision: state.revision,
    stage: state.stage,
    phase: state.phase,
    status: state.status,
    requestVersion: state.requestVersion,
    resumeToken: state.resumeToken,
    blockerCode: state.blocker?.code,
    terminalClassification: state.terminal?.classification,
    pendingEvidence: state.evidenceRequirements
      .filter((item) => item.required && !verified.has(item.id))
      .slice(0, MAX_PENDING)
      .map((item) => ({ id: item.id, kind: item.kind })),
    pendingApprovals: state.approvalChallenges
      .filter((item) => item.status === "pending")
      .slice(0, MAX_PENDING)
      .map((item) => ({ id: item.id, kind: item.kind })),
  }
}

export function publishWorkflowHookSnapshot(state: BuildWorkflowState): WorkflowHookSnapshot {
  const snapshot = workflowHookSnapshotFromState(state)
  latestBySession.delete(snapshot.sessionId)
  latestBySession.set(snapshot.sessionId, snapshot)
  while (latestBySession.size > MAX_SESSIONS) {
    const oldest = latestBySession.keys().next().value
    if (oldest === undefined) break
    latestBySession.delete(oldest)
  }
  return snapshot
}

export function getWorkflowHookSnapshot(sessionId: string): WorkflowHookSnapshot | undefined {
  const snapshot = latestBySession.get(sessionId)
  if (!snapshot || snapshot.sessionId !== sessionId) return undefined
  return structuredClone(snapshot)
}

export function clearWorkflowHookSnapshot(sessionId: string): void {
  latestBySession.delete(sessionId)
}

export function clearAllWorkflowHookSnapshots(): void {
  latestBySession.clear()
}
