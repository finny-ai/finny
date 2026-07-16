import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api"
import type { Hooks, PluginInput, ToolHookContext, ToolHookErrorOutput } from "@opencode-ai/plugin"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import { sanitizeTelemetryPayload } from "@/security/telemetry"
import { runTelemetryAttributes, sessionTelemetryAttributes } from "@/telemetry/run-attributes"
import {
  clearWorkflowHookSnapshot,
  getWorkflowHookSnapshot,
  type WorkflowHookSnapshot,
} from "@/algorithm/build-workflow/hook-snapshot"
import { WORKFLOW_RUN_PHASES, WORKFLOW_STAGES } from "@/algorithm/build-workflow/types"
import {
  evaluateFinnyWorkspacePathPolicy,
  FinnyWorkspacePolicyError,
  type FinnyWorkspaceOperation,
} from "@/tool/finny-workspace-guard"

const MAX_COMPACTION_CONTEXT = 2_000
const HASH_ONLY = { enabled: false } as const
export const FINNY_HARNESS_HOOK = Symbol("finny.harness.hook")
const WORKSPACE_TOOL_OPERATIONS: Partial<Record<string, FinnyWorkspaceOperation>> = {
  read: "read",
  write: "write",
  edit: "edit",
}
const ERROR_NAME_CLASSIFICATIONS = new Map<string, string>([
  ["AbortError", "abort"],
  ["TypeError", "validation"],
  ["SyntaxError", "validation"],
])
const BUILTIN_TOOLS = new Set([
  "apply_patch",
  "bash",
  "edit",
  "glob",
  "grep",
  "invalid",
  "list_subagents",
  "list_tasks",
  "lsp",
  "plan_enter",
  "plan_exit",
  "question",
  "read",
  "schedule_subagent",
  "skill",
  "stop_subagent",
  "stop_task",
  "task",
  "task_batch_run",
  "task_run",
  "task_start",
  "task_status",
  "todo_read",
  "todo_write",
  "webfetch",
  "websearch",
  "write",
])

type HarnessOutcome = "completed" | "blocked" | "failed" | "cancelled" | "policy_blocked"

type ActiveSpan = {
  span: Span
  context: ToolHookContext
}

function spanKey(input: Pick<ToolHookContext, "sessionID" | "callID">): string {
  return `${input.sessionID}\0${input.callID}`
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function toolAttributes(tool: string): Attributes {
  if (/^finny_[a-z0-9_]+$/.test(tool)) return { "tool.kind": "finny", "tool.name": tool }
  if (BUILTIN_TOOLS.has(tool)) return { "tool.kind": "builtin", "tool.name": tool }
  return { "tool.kind": "custom_or_mcp", "tool.name_hash": shortHash(tool) }
}

function payloadAttributes(prefix: string, value: unknown): Attributes {
  const payload = sanitizeTelemetryPayload(value, HASH_ONLY)
  return {
    [`${prefix}.sha256`]: payload.sha256,
    [`${prefix}.bytes`]: payload.originalBytes,
    [`${prefix}.captured_bytes`]: payload.capturedBytes,
  }
}

function snapshotAttributes(snapshot: WorkflowHookSnapshot | undefined): Attributes {
  if (!snapshot) return {}
  return {
    "finny.workflow.id": snapshot.workflowId,
    "finny.workflow.revision": snapshot.revision,
    "finny.workflow.stage": snapshot.stage,
    "finny.workflow.phase": snapshot.phase,
    "finny.workflow.status": snapshot.status,
    "finny.workflow.request_version": snapshot.requestVersion,
    ...(snapshot.blockerCode ? { "finny.workflow.blocker_code": snapshot.blockerCode } : {}),
    ...(snapshot.terminalClassification
      ? { "finny.workflow.terminal_classification": snapshot.terminalClassification }
      : {}),
  }
}

function stringMetadata(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const value = (metadata as Record<string, unknown>)[key]
  return safeIdentifier(value)
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined
}

function artifactIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return []
  const value = metadata as Record<string, unknown>
  const items = [value.artifactId, value.runId, ...(Array.isArray(value.artifactIds) ? value.artifactIds : [])]
  return items
    .map(safeIdentifier)
    .filter((item): item is string => item !== undefined)
    .slice(0, 10)
}

function classifiedError(error: unknown): string {
  if (error instanceof FinnyWorkspacePolicyError) return "workspace_policy"
  const name = error instanceof Error ? error.name : ""
  const exact = ERROR_NAME_CLASSIFICATIONS.get(name)
  if (exact) return exact
  const pattern = [/permission/i, /timeout/i].findIndex((candidate) => candidate.test(name))
  return ["permission", "timeout"][pattern] ?? "other"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorOutcome(output: ToolHookErrorOutput): HarnessOutcome {
  if (output.error instanceof FinnyWorkspacePolicyError) return "policy_blocked"
  if (output.interrupted || (output.error instanceof Error && output.error.name === "AbortError")) return "cancelled"
  return "failed"
}

function fallbackSnapshot(value: unknown, sessionID: string): WorkflowHookSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const item = value as Record<string, unknown>
  const workflowId = safeIdentifier(item.workflow_id)
  const resumeToken = safeIdentifier(item.resume_token)
  const revision = item.workflow_revision
  const requestVersion = item.request_version
  const valid = [
    item.source_of_truth === "algorithm_build_workflow",
    item.request_id === sessionID,
    workflowId !== undefined,
    resumeToken !== undefined,
    WORKFLOW_STAGES.includes(item.workflow_stage as any),
    WORKFLOW_RUN_PHASES.includes(item.workflow_phase as any),
    Number.isInteger(revision),
    typeof revision === "number" && revision >= 0,
    Number.isInteger(requestVersion),
    typeof requestVersion === "number" && requestVersion >= 1,
  ].every(Boolean)
  if (!valid) return undefined
  return {
    workflowId: workflowId!,
    sessionId: sessionID,
    revision: revision as number,
    stage: item.workflow_stage as WorkflowHookSnapshot["stage"],
    phase: item.workflow_phase as WorkflowHookSnapshot["phase"],
    status: "active",
    requestVersion: requestVersion as number,
    resumeToken: resumeToken!,
    pendingEvidence: [],
    pendingApprovals: [],
  }
}

async function requestProjectionSnapshot(sessionID: string): Promise<WorkflowHookSnapshot | undefined> {
  const slug = await getSessionWorkspace(sessionID).catch(() => null)
  if (!slug) return undefined
  try {
    const raw = await fs.readFile(path.join(algoDir(slug), "request.json"), "utf8")
    return fallbackSnapshot(JSON.parse(raw), sessionID)
  } catch {
    return undefined
  }
}

export function renderWorkflowCompactionContext(snapshot: WorkflowHookSnapshot): string {
  const pendingEvidence = snapshot.pendingEvidence.map((item) => `${item.id}:${item.kind}`).join(", ") || "none"
  const pendingApprovals = snapshot.pendingApprovals.map((item) => `${item.id}:${item.kind}`).join(", ") || "none"
  const lines = [
    "## Authoritative workflow state",
    `workflow_id: ${snapshot.workflowId}`,
    `revision: ${snapshot.revision}`,
    `stage: ${snapshot.stage}`,
    `phase: ${snapshot.phase}`,
    `status: ${snapshot.status}`,
    `request_version: ${snapshot.requestVersion}`,
    `resume_token: ${snapshot.resumeToken}`,
    `blocker: ${snapshot.blockerCode ?? "none"}`,
    `terminal: ${snapshot.terminalClassification ?? "none"}`,
    `pending_evidence: ${pendingEvidence}`,
    `pending_approvals: ${pendingApprovals}`,
  ]
  return lines.join("\n").slice(0, MAX_COMPACTION_CONTEXT)
}

function harnessSpanAttributes(event: ToolHookContext, args: unknown): Attributes {
  return {
    ...runTelemetryAttributes(),
    ...sessionTelemetryAttributes(event.sessionID, event.parentSessionID),
    ...toolAttributes(event.tool),
    ...payloadAttributes("tool.input", args),
    ...snapshotAttributes(getWorkflowHookSnapshot(event.sessionID)),
    "tool.call_id": event.callID,
    ...(event.messageID ? { "message.id": event.messageID } : {}),
    ...(event.agent ? { "finny.agent_hash": shortHash(event.agent) } : {}),
  }
}

function toolPath(args: Record<string, any>): string | undefined {
  const value = args?.filePath ?? args?.file_path
  return typeof value === "string" ? value : undefined
}

async function enforceWorkspacePolicy(input: PluginInput, event: ToolHookContext, args: Record<string, any>) {
  const operation = WORKSPACE_TOOL_OPERATIONS[event.tool]
  if (!operation) return
  const filePath = toolPath(args)
  if (!filePath) return
  const result = await evaluateFinnyWorkspacePathPolicy({
    agent: event.agent,
    sessionID: event.sessionID,
    filePath,
    operation,
    directory: input.directory,
    worktree: input.worktree,
  })
  if (!result.allowed) throw new FinnyWorkspacePolicyError(result)
}

function blockerCode(metadata: unknown): string | undefined {
  return stringMetadata(metadata, "blockerCode") ?? stringMetadata(metadata, "blocker_code")
}

function isBlocked(metadata: unknown, snapshot: WorkflowHookSnapshot | undefined, code: string | undefined): boolean {
  const markedBlocked = (metadata as Record<string, unknown> | undefined)?.blocked === true
  return [code !== undefined, markedBlocked, snapshot?.status === "blocked"].some(Boolean)
}

export function createFinnyHarnessHooks(input: PluginInput, tracer: Tracer): Hooks {
  const active = new Map<string, ActiveSpan>()
  const touchedSessions = new Set<string>()

  function close(key: string, outcome: HarnessOutcome, attributes: Attributes = {}): void {
    const current = active.get(key)
    if (!current) return
    active.delete(key)
    current.span.setAttributes({ "finny.harness.outcome": outcome, ...attributes })
    current.span.setStatus({
      code: outcome === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      ...(outcome === "completed" ? {} : { message: outcome }),
    })
    current.span.end()
  }

  const hooks: Hooks = {
    "tool.execute.before": async (event, output) => {
      touchedSessions.add(event.sessionID)
      const key = spanKey(event)
      close(key, "cancelled", { "finny.harness.replaced": true })
      const span = tracer.startSpan("finny.harness.tool", {
        attributes: harnessSpanAttributes(event, output.args),
      })
      active.set(key, { span, context: event })
      await enforceWorkspacePolicy(input, event, output.args)
    },

    "tool.execute.after": async (event, output) => {
      const metadata = output?.metadata
      const snapshot = getWorkflowHookSnapshot(event.sessionID)
      const code = blockerCode(metadata)
      const blocked = isBlocked(metadata, snapshot, code)
      const ids = artifactIds(metadata)
      close(spanKey(event), blocked ? "blocked" : "completed", {
        ...payloadAttributes("tool.output", output),
        ...snapshotAttributes(snapshot),
        ...(code ? { "finny.workflow.blocker_code": code } : {}),
        ...(ids.length ? { "finny.workflow.artifact_ids": ids } : {}),
      })
    },

    "tool.execute.error": async (event, output) => {
      const message = payloadAttributes("error.message", errorMessage(output.error))
      close(spanKey(event), errorOutcome(output), {
        ...message,
        "error.type": classifiedError(output.error),
        "tool.error_phase": output.phase,
      })
    },

    "experimental.session.compacting": async (event, output) => {
      touchedSessions.add(event.sessionID)
      const snapshot = getWorkflowHookSnapshot(event.sessionID) ?? (await requestProjectionSnapshot(event.sessionID))
      if (!snapshot || snapshot.sessionId !== event.sessionID) return
      output.context.push(renderWorkflowCompactionContext(snapshot))
    },

    event: async (event) => {
      if (event.event.type !== "session.deleted") return
      const sessionID = (event.event.properties as { info?: { id?: unknown } }).info?.id
      if (typeof sessionID !== "string") return
      for (const [key, current] of active) {
        if (current.context.sessionID === sessionID) close(key, "cancelled")
      }
      clearWorkflowHookSnapshot(sessionID)
      touchedSessions.delete(sessionID)
    },

    dispose: async () => {
      for (const key of [...active.keys()]) close(key, "cancelled")
      for (const sessionID of touchedSessions) clearWorkflowHookSnapshot(sessionID)
      touchedSessions.clear()
    },
  }
  Object.defineProperty(hooks, FINNY_HARNESS_HOOK, { value: true })
  return hooks
}

export async function FinnyHarnessPlugin(input: PluginInput): Promise<Hooks> {
  return createFinnyHarnessHooks(input, trace.getTracer("finny.harness"))
}
