import { approvalScopeHash, paperTradingApprovalScope } from "./state"
import type { BuildWorkflowState } from "./types"

export interface ControllerPaperApproval {
  workflowId: string
  challengeId: string
  scopeHash: string
  runId: string
  identityHash: string
  grantedAt: number
  sourceMessageId?: string
  questionRequestId?: string
}

/**
 * Materialize a paper-approval proof only from the authoritative workflow
 * snapshot. The proof is intentionally not accepted from HTTP/tool input.
 */
// @codescene(disable-all) Approval materialization is intentionally one immutable proof boundary.
export function controllerPaperApproval(
  state: BuildWorkflowState | undefined,
  input: {
    algorithmId: string
    algorithmVersion: number
    runId: string
    identityHash: string
  },
): ControllerPaperApproval | undefined {
  if (!state || state.stage !== "paper_approved" || state.status !== "active") return undefined
  if (
    state.candidate?.algorithmId !== input.algorithmId ||
    state.candidate.version !== input.algorithmVersion ||
    state.backtest?.runId !== input.runId ||
    state.backtest.verdict !== "recommended_for_paper" ||
    state.backtest.hashes.strictRunIdentityHash !== input.identityHash
  ) {
    return undefined
  }
  const expectedScope = paperTradingApprovalScope(state.backtest)
  const expectedScopeHash = approvalScopeHash("paper_trading", expectedScope)
  const approval = state.approvals.find(
    (item) => item.kind === "paper_trading" && item.scopeHash === expectedScopeHash,
  )
  if (!approval || (!approval.sourceMessageId && !approval.questionRequestId)) return undefined
  const challenge = state.approvalChallenges.find(
    (item) =>
      item.id === approval.challengeId &&
      item.kind === "paper_trading" &&
      item.status === "approved" &&
      item.scopeHash === expectedScopeHash,
  )
  if (!challenge) return undefined
  return {
    workflowId: state.workflowId,
    challengeId: challenge.id,
    scopeHash: expectedScopeHash,
    runId: input.runId,
    identityHash: input.identityHash,
    grantedAt: approval.grantedAt,
    ...(approval.sourceMessageId ? { sourceMessageId: approval.sourceMessageId } : {}),
    ...(approval.questionRequestId ? { questionRequestId: approval.questionRequestId } : {}),
  }
}
