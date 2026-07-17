import type { BuildWorkflowState } from "@/algorithm/build-workflow/types"
import { SAFE_PARENT_OVERLAP_TOOLS } from "@/task/strategy-context"

export const MIN_FAILED_METRIC_TRIALS = 5

type WorkflowPart = { type: string; tool?: string; state?: { status?: string }; text?: string }
type WorkflowMessage = { parts: WorkflowPart[] }

function isCompletedTool(part: WorkflowPart, tool?: string) {
  if (part.type !== "tool" || part.state?.status !== "completed") return false
  return tool === undefined || part.tool === tool
}

function isCompletedSafeOverlap(part: WorkflowPart) {
  return isCompletedTool(part) && part.tool !== undefined && SAFE_PARENT_OVERLAP_TOOLS.has(part.tool)
}

export function shouldResumeInterruptedWorkflow(input: {
  workflow: BuildWorkflowState | undefined
  lastUserCreatedAt: number
  hasRealContinuationText: boolean
}) {
  const workflow = input.workflow
  if (workflow?.status !== "blocked") return false
  if (workflow.blocker?.code !== "workflow_interrupted") return false
  if (!input.hasRealContinuationText) return false
  return input.lastUserCreatedAt > workflow.updatedAt
}

/**
 * A context batch only counts as concurrent orchestration when the parent does
 * one useful, non-overlapping preparation action after launching it. Keep this
 * allow-list deliberately narrow: evidence, synthesis, save, backtest, and
 * review tools remain owned by the post-context workflow.
 */
export function hasParentOverlapActionAfterContextLaunch(messages: WorkflowMessage[]) {
  const parts = messages.flatMap((message) => message.parts)
  const launchIndex = parts.findLastIndex((part) => isCompletedTool(part, "task_batch_run"))
  return launchIndex < 0 || parts.slice(launchIndex + 1).some(isCompletedSafeOverlap)
}

function uniqueMetricTrials(state: BuildWorkflowState) {
  return new Set(
    state.experimentAttempts.filter((attempt) => attempt.outcome === "metrics").map((attempt) => attempt.replayKey),
  ).size
}

function requiredIterationAction(workflow: BuildWorkflowState, rotateConcept: boolean) {
  if (workflow.candidate && !workflow.backtest) {
    return [
      `Your next response MUST call finny_backtest now for saved candidate v${workflow.candidate.version}; narrative-only output is invalid.`,
      "Do not save another candidate, summarize, or claim concept exhaustion before this candidate produces metrics.",
    ]
  }

  const nextVersion = workflow.candidate ? workflow.candidate.version + 1 : 1
  return [
    rotateConcept
      ? `Your next response MUST call finny_algorithm_save for a fresh strategy concept family as v${nextVersion}, not another parameter-only tweak; narrative-only output is invalid.`
      : `Your next response MUST call finny_algorithm_save for a materially corrected or alternative concept as v${nextVersion}; narrative-only output is invalid.`,
    "After that save succeeds, the next required action is finny_backtest for the newly saved candidate on the exact requested window.",
  ]
}

type ContinuationInput = {
  workflow: BuildWorkflowState | undefined
  pendingContextTasks: number
  unverifiedContextRoles?: readonly string[]
  parentOverlapComplete?: boolean
  saveHardBoundary?: boolean
  /** Latest assistant narrative text. Used to detect user handoffs. */
  assistantText?: string
  /** Latest assistant parts. Used to detect question-tool handoffs. */
  assistantParts?: WorkflowPart[]
}

function pendingContextReminder(
  workflow: BuildWorkflowState,
  pendingContextTasks: number,
  parentOverlapComplete = false,
) {
  if (parentOverlapComplete) return undefined
  return [
    "<system-reminder>",
    `Durable Build workflow ${workflow.workflowId} has ${pendingContextTasks} background context task(s) still running.`,
    "Before yielding, complete at least one useful non-overlapping parent preparation action after the context batch launch.",
    "You may inspect the mission/request projection or prepare the evaluation checklist/todos.",
    "Do not synthesize strategy evidence, save a candidate, run a backtest, generate a review packet, or touch subagent-owned evidence until all context tasks return.",
    "</system-reminder>",
  ].join("\n")
}

function missingEvidenceLaunchInstruction(roles: readonly string[]) {
  if (roles.length > 1) {
    return `Call task_batch_run now without task_id for every missing role (${roles.join(", ")}) so each retry gets a fresh child session.`
  }
  return `Call task_run now for ${roles[0]} without task_id so the retry gets a fresh child session.`
}

function unverifiedEvidenceReminder(workflow: BuildWorkflowState, roles: readonly string[]) {
  return [
    "<system-reminder>",
    `Durable Build workflow ${workflow.workflowId} still lacks verified context evidence for: ${roles.join(", ")}.`,
    "A completed child or readable artifact is not verified WorkflowRun evidence.",
    missingEvidenceLaunchInstruction(roles),
    "Do not synthesize, save, backtest, emit a final summary, or report missing build capabilities while required context evidence is unverified.",
    "Wait for automatic delivery, then continue only after WorkflowRun records verified evidence.",
    "</system-reminder>",
  ].join("\n")
}

/**
 * A non-failed completed backtest is presentable research. The harness must
 * stop auto-iteration so the agent can show the champion to the user instead
 * of burning tokens on endless save/backtest retries.
 *
 * `recommended_for_paper` also becomes phase=qualified, but `candidate` and
 * provider-fetch `research_only` never do — those still count as a proper
 * strategy the user should see and decide on.
 */
export function hasPresentableResearchResult(workflow: BuildWorkflowState) {
  const verdict = workflow.backtest?.verdict
  return verdict === "candidate" || verdict === "research_only" || verdict === "recommended_for_paper"
}

const USER_YIELD_PHRASE_RE =
  /\b(?:let me know|would you like|do you want|shall i|should i|your (?:call|choice|preference|decision)|awaiting your|waiting for your|what would you like|how would you like|what should (?:i|we)|want me to|if you(?:'d| would) like|ready for (?:your|paper)|paper[- ]trad(?:e|ing) (?:these|this|the)|begin paper)\b/i

/**
 * User has primary control. If the assistant is asking the user what to do,
 * auto-continuation must not skip that handoff and restart iteration.
 */
export function isYieldingControlToUser(input: { assistantText?: string; assistantParts?: WorkflowPart[] }) {
  if (input.assistantParts?.some((part) => part.type === "tool" && part.tool === "question")) {
    return true
  }
  const text = input.assistantText?.trim()
  if (!text) return false
  if (/\?\s*$/.test(text)) return true
  // Question mark near the end of a multi-paragraph handoff.
  if (/\?[^\n]*\n*$/.test(text) || (text.includes("?") && USER_YIELD_PHRASE_RE.test(text))) return true
  return USER_YIELD_PHRASE_RE.test(text)
}

function workflowShouldStopAutoIteration(input: ContinuationInput, workflow: BuildWorkflowState) {
  if (input.saveHardBoundary === true) return true
  if (["qualified", "terminal_complete", "terminal_failed"].includes(workflow.phase)) return true
  if (hasPresentableResearchResult(workflow)) return true
  if (
    isYieldingControlToUser({
      assistantText: input.assistantText,
      assistantParts: input.assistantParts,
    })
  ) {
    return true
  }
  return false
}

function iterationReminder(workflow: BuildWorkflowState) {
  const metricTrials = uniqueMetricTrials(workflow)
  const requiredAction = requiredIterationAction(workflow, metricTrials >= MIN_FAILED_METRIC_TRIALS)
  return [
    "<system-reminder>",
    `Durable Build workflow ${workflow.workflowId} is still active at phase ${workflow.phase}.`,
    `Completed metric trials: ${metricTrials}. Trial count does not authorize a terminal failure while this workflow remains active without a presentable non-failed research result.`,
    `After ${MIN_FAILED_METRIC_TRIALS} failed metric trials, rotate to a fresh strategy concept family and continue save/backtest iteration.`,
    "concept_exhausted is not an admissible outcome while the workflow remains active and every metric trial is still failed. Do not emit it or paraphrase it as a terminal summary.",
    "Do not stop with a narrative-only summary after a failed or missing metric trial. Keep iterating until you either produce a presentable non-failed result (candidate, research_only, or recommended_for_paper) or yield control by asking the user what to do next.",
    "User control wins: if you need a user decision, ask clearly and stop. Do not auto-continue past a user-facing question.",
    ...requiredAction,
    "Only after a robust recommended_for_paper WorkflowRun qualification, generate the one recommended_for_paper final review packet before stopping; paper approval remains a separate human decision. A research_only/candidate champion should be presented to the user and stopped without further forced iteration.",
    "</system-reminder>",
  ].join("\n")
}

type ContextReminderDecision = { handled: false } | { handled: true; reminder: string | undefined }

function contextReminderDecision(input: ContinuationInput, workflow: BuildWorkflowState): ContextReminderDecision {
  if (input.pendingContextTasks > 0) {
    return {
      handled: true,
      reminder: pendingContextReminder(workflow, input.pendingContextTasks, input.parentOverlapComplete),
    }
  }
  const roles = [...new Set(input.unverifiedContextRoles ?? [])].sort()
  return roles.length > 0
    ? { handled: true, reminder: unverifiedEvidenceReminder(workflow, roles) }
    : { handled: false }
}

export function buildWorkflowContinuationReminder(input: ContinuationInput) {
  const workflow = input.workflow
  if (!workflow || workflow.status !== "active") return undefined
  const context = contextReminderDecision(input, workflow)
  if (context.handled) return context.reminder
  return workflowShouldStopAutoIteration(input, workflow) ? undefined : iterationReminder(workflow)
}
