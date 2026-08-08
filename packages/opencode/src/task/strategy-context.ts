import type { Database } from "@opencode-ai/core/database/database"
import type { BuildWorkflowState, EvidenceKind } from "@/algorithm/build-workflow/types"
import type { SessionID } from "@/session/schema"
import { TaskState } from "./state"

const CONTEXT_SUBAGENT_TYPES = new Set(["data_extractor", "news_agent", "researcher", "sec_agent", "sentiment_agent"])

export const SAFE_PARENT_OVERLAP_TOOLS = new Set(["read", "glob", "grep", "todowrite"])

const CONTEXT_GATED_TOOLS = new Set([
  "apply_patch",
  "finny_get_history",
  "finny_get_quote",
  "finny_algorithm_set_params",
  "finny_algorithm_scaffold",
  "finny_algorithm_validate",
  "finny_backtest",
  "finny_backtest_sweep",
  "finny_portfolio_backtest",
  "qualify_candidate",
  "finny_review_packet",
  "finny_paper_approve",
  "webfetch",
  "websearch",
])

export function filterContextPhaseTools<T extends { id: string }>(
  definitions: T[],
  _input: { pendingCount: number; launchRequired: boolean },
) {
  // Keep the main-agent capability contract truthful. Phase safety is enforced
  // by contextPhaseExecutionBlock at execution time, not by hiding tools that
  // the system prompt has already advertised.
  return definitions
}

type ContextTaskRef = { id: string; subagentType: string }

export type ContextPhaseGate = {
  unlaunchedRequiredRoles: readonly string[]
  pendingTasks: readonly ContextTaskRef[]
}

type ContextExecutionBlock = {
  title: string
  output: string
  attachments?: never
  metadata: {
    blocked: true
    strategyContext: "launch_required" | "pending"
    missingRoles?: readonly string[]
    pendingContext?: string[]
  }
}

function launchRequiredOutput(action: string, roles: readonly string[]) {
  const launch = roles.length > 1
    ? `Call task_batch_run now with every missing role (${roles.join(", ")}) so they start concurrently.`
    : `Call task_run or task_start now for ${roles[0]}.`
  return [
    `BLOCKED: ${action} cannot run before the controlled strategy-context kickoff.`,
    `Missing required roles: ${roles.join(", ")}.`,
    launch,
  ].join(" ")
}

function launchExecutionBlock(toolID: string, roles: readonly string[]): ContextExecutionBlock | undefined {
  if (roles.length === 0) return undefined
  return {
    title: `${toolID} waiting for strategy-context kickoff`,
    output: launchRequiredOutput(toolID, roles),
    metadata: {
      blocked: true,
      strategyContext: "launch_required",
      missingRoles: roles,
    },
  }
}

function pendingExecutionBlock(toolID: string, tasks: readonly ContextTaskRef[]): ContextExecutionBlock | undefined {
  if (tasks.length === 0) return undefined
  return {
    title: `${toolID} waiting for strategy context`,
    output: blockedOutput(toolID, tasks),
    metadata: {
      blocked: true,
      strategyContext: "pending",
      pendingContext: tasks.map((task) => `${task.subagentType}:${task.id}`),
    },
  }
}

export function contextPhaseExecutionBlock(
  toolID: string,
  gate: ContextPhaseGate | undefined,
): ContextExecutionBlock | undefined {
  if (!gate || !CONTEXT_GATED_TOOLS.has(toolID)) return undefined
  return launchExecutionBlock(toolID, gate.unlaunchedRequiredRoles)
    ?? pendingExecutionBlock(toolID, gate.pendingTasks)
}

const ROLE_BY_EVIDENCE_KIND: Partial<Record<EvidenceKind, string>> = {
  market_data: "data_extractor",
  news: "news_agent",
  sec: "sec_agent",
  sentiment: "sentiment_agent",
}

/** The controlled delegated kickoff is the market-data plus news evidence workflow. */
export function requiresConcurrentContextKickoff(workflow: BuildWorkflowState) {
  const requiredKinds = new Set(
    workflow.evidenceRequirements.filter((requirement) => requirement.required).map((requirement) => requirement.kind),
  )
  return requiredKinds.has("market_data") && requiredKinds.has("news")
}

export function unmetRequiredContextRoles(workflow: BuildWorkflowState) {
  const verified = new Set(
    workflow.evidence
      .filter((record) => record.status === "verified")
      .map((record) => record.requirementId),
  )
  return [
    ...new Set(
      workflow.evidenceRequirements
        .filter((requirement) => requirement.required && !verified.has(requirement.id))
        .flatMap((requirement) => {
          const role = ROLE_BY_EVIDENCE_KIND[requirement.kind]
          return role ? [role] : []
        }),
    ),
  ].sort()
}

export function unlaunchedRequiredContextRoles(
  workflow: BuildWorkflowState,
  tasks: ReadonlyArray<Pick<TaskState.Info, "subagentType" | "status">>,
) {
  const activeRoles = new Set(
    tasks.filter((task) => !TaskState.isTerminal(task.status)).map((task) => task.subagentType),
  )
  return unmetRequiredContextRoles(workflow).filter((role) => !activeRoles.has(role))
}

function requiresConcurrentBatch(missing: readonly string[], batch: boolean) {
  return missing.length > 1 && !batch
}

function omittedRoles(missing: readonly string[], requestedRoles: readonly string[]) {
  const requested = new Set(requestedRoles)
  return missing.filter((role) => !requested.has(role))
}

function isIncompleteContextLaunch(input: {
  missing: readonly string[]
  requestedRoles: readonly string[]
  batch: boolean
}) {
  if (omittedRoles(input.missing, input.requestedRoles).length > 0) return true
  return requiresConcurrentBatch(input.missing, input.batch)
}

function contextLaunchInstruction(missing: readonly string[]) {
  if (missing.length > 1) {
    return `Launch one task_batch_run containing every missing role (${missing.join(", ")}) so they start concurrently.`
  }
  return `Launch ${missing[0]} before direct data access or strategy synthesis.`
}

export function requiredContextLaunchBlock(input: {
  workflow: BuildWorkflowState
  tasks: ReadonlyArray<Pick<TaskState.Info, "subagentType" | "status">>
  requestedRoles: readonly string[]
  batch: boolean
}) {
  if (!requiresConcurrentContextKickoff(input.workflow)) return undefined
  const missing = unlaunchedRequiredContextRoles(input.workflow, input.tasks)
  if (missing.length === 0) return undefined
  if (!isIncompleteContextLaunch({ missing, requestedRoles: input.requestedRoles, batch: input.batch })) return undefined
  return [
    "BLOCKED: the controlled strategy-context kickoff is incomplete.",
    `Missing required roles: ${missing.join(", ")}.`,
    contextLaunchInstruction(missing),
  ].join(" ")
}

export function requiredContextLaunchSystemFragment(roles: readonly string[]) {
  const uniqueRoles = [...new Set(roles)].sort()
  if (uniqueRoles.length === 0) return ""
  return [
    "<strategy-context-kickoff>",
    "Required WorkflowRun evidence is still unverified.",
    `Missing required roles: ${uniqueRoles.join(", ")}.`,
    uniqueRoles.length > 1
      ? `Call task_batch_run once with every missing role (${uniqueRoles.join(", ")}) so they start concurrently.`
      : `Call task_run or task_start now for ${uniqueRoles[0]}.`,
    "A readable artifact or completed child task does not satisfy this gate unless WorkflowRun records verified evidence.",
    "Do not synthesize, save, backtest, or report missing capabilities. Relaunch the exact missing role(s) and wait for verified delivery.",
    "</strategy-context-kickoff>",
  ].join("\n")
}

type DeliveryPart = { type?: string; text?: string; synthetic?: boolean }
type DeliveryMessage = { parts?: DeliveryPart[] }
type DeliveredTask = { id: string; status: "blocked" | "completed" | "failed"; summary: string }

function isSyntheticTextPart(part: DeliveryPart): part is DeliveryPart & { text: string } {
  if (part.type !== "text") return false
  if (part.synthetic !== true) return false
  return typeof part.text === "string"
}

function normalizedDeliveryResult(body: string) {
  return body.match(/<task_(?:result|error)>([\s\S]*?)<\/task_(?:result|error)>/)?.[1]?.trim() ?? body
}

function deliveredTaskStatus(state: string, result: string): DeliveredTask["status"] {
  if (state === "error") return "failed"
  return /^BLOCKED:/i.test(result) ? "blocked" : "completed"
}

function parseDeliveredTasks(text: string): DeliveredTask[] {
  const matches = text.matchAll(/<task id="([^"]+)" state="(completed|error)">([\s\S]*?)<\/task>/g)
  return [...matches].flatMap((match) => {
    const id = match[1]
    if (!id) return []
    const result = normalizedDeliveryResult((match[3] ?? "").trim())
    return [{
      id,
      status: deliveredTaskStatus(match[2] ?? "", result),
      summary: result.replace(/\s+/g, " ").slice(0, 2_000),
    }]
  })
}

export function deliveredTaskIDs(messages: DeliveryMessage[] = []) {
  const delivered = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "text" || part.synthetic !== true || typeof part.text !== "string") continue
      for (const match of part.text.matchAll(/<task id="([^"]+)" state="(?:completed|error)">/g)) {
        if (match[1]) delivered.add(match[1])
      }
    }
  }
  return delivered
}

export function deliveredTasks(messages: DeliveryMessage[] = []) {
  const parts = messages.flatMap((message) => message.parts ?? []).filter(isSyntheticTextPart)
  const deliveries = parts.flatMap((part) => parseDeliveredTasks(part.text))
  const delivered = new Map(deliveries.map((delivery) => [delivery.id, delivery]))
  return [...delivered.values()]
}

/**
 * A background result is delivered when its synthetic user message is
 * durably admitted to the parent session. Finalize the registry at that
 * boundary instead of waiting for the whole follow-up model turn to finish:
 * that turn can be interrupted after admission, which otherwise leaves a
 * permanently-running task even though the parent already consumed it.
 */
export async function finalizeDeliveredTasks(
  sessionID: SessionID | string,
  database: Database.Interface,
  messages: DeliveryMessage[],
) {
  for (const delivery of deliveredTasks(messages)) {
    const task = await TaskState.get(delivery.id, database)
    if (!task || task.parentSessionID !== sessionID) continue
    await TaskState.finalizeActive(
      delivery.id,
      {
        status: delivery.status,
        resultSummary: delivery.summary,
        lastError: delivery.status === "failed" ? delivery.summary : null,
      },
      database,
    )
  }
}

export async function pendingTasks(
  sessionID: SessionID | string,
  database?: Database.Interface,
  messages: DeliveryMessage[] = [],
) {
  const delivered = deliveredTaskIDs(messages)
  return (await TaskState.listByParent(sessionID, database)).filter(
    (task) =>
      CONTEXT_SUBAGENT_TYPES.has(task.subagentType) &&
      !TaskState.isTerminal(task.status) &&
      !delivered.has(task.id),
  )
}

export async function contextTasks(sessionID: SessionID | string, database?: Database.Interface) {
  return (await TaskState.listByParent(sessionID, database)).filter((task) =>
    CONTEXT_SUBAGENT_TYPES.has(task.subagentType),
  )
}

export function blockedOutput(action: string, tasks: readonly ContextTaskRef[]) {
  const pending = tasks.map((task) => `${task.subagentType}:${task.id}`).join(", ")
  return [
    `BLOCKED: ${action} must wait for the active strategy-context subagents to finish.`,
    `Pending context: ${pending}.`,
    "Call finny_strategy_context_wait once to wait for every pending context task without polling.",
    "Do not duplicate or synthesize the strategy until that wait returns every completion result.",
  ].join(" ")
}

export async function duplicateFetchBlock(
  action: string,
  sessionID: SessionID | string,
  database: Database.Interface,
  messages: DeliveryMessage[] = [],
) {
  const pending = await pendingTasks(sessionID, database, messages)
  if (pending.length === 0) return undefined
  return {
    title: `${action} waiting for strategy context`,
    output: blockedOutput(action, pending),
    metadata: {
      blocked: true,
      pendingContext: pending.map((task) => `${task.subagentType}:${task.id}`),
    },
  }
}

export * as StrategyContext from "./strategy-context"
