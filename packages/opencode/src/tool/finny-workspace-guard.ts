import * as path from "path"
import { existsSync } from "fs"
import { Effect, Schema } from "effect"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import type { Tool } from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { StrategyContext } from "@/task/strategy-context"
import type { Database } from "@opencode-ai/core/database/database"

export type FinnyWorkspaceOperation = "read" | "write" | "edit"

export type FinnyWorkspacePolicyResult = { allowed: true } | { allowed: false; code: string; message: string }

type FinnyWorkspacePolicyInput = {
  agent?: string
  sessionID: string
  filePath: string
  operation: FinnyWorkspaceOperation
  directory: string
  worktree: string
}

type ArtifactKind = "news" | "sec" | "sentiment"

const ARTIFACT_KIND_BY_AGENT: Partial<Record<string, ArtifactKind>> = {
  news_agent: "news",
  researcher: "news",
  sec_agent: "sec",
  sentiment_agent: "sentiment",
}

const AGENT_LABELS: Partial<Record<string, string>> = {
  researcher: "Researcher",
  news_agent: "News Agent",
  sec_agent: "SEC Agent",
  sentiment_agent: "Sentiment Agent",
}

const WORKSPACE_BINDINGS: Record<ArtifactKind, string> = {
  news: "workspace_news_dir",
  sec: "allowed_sec_dir",
  sentiment: "allowed_sentiment_dir",
}

const ARTIFACT_NOUNS: Record<ArtifactKind, string> = {
  news: "news",
  sec: "SEC",
  sentiment: "sentiment",
}

export class FinnyWorkspacePolicyError extends Schema.TaggedErrorClass<FinnyWorkspacePolicyError>()(
  "FinnyWorkspacePolicyError",
  { code: Schema.String, message: Schema.String },
) {}

export function sameOrInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function findFinnyAlgoRoot(directory: string, worktree: string): string {
  const starts = [...new Set([directory, worktree].filter((item) => item && item !== "/"))]
  for (const start of starts) {
    let current = path.resolve(start)
    while (true) {
      if (existsSync(path.join(current, "algos/_template/README.md"))) return current
      const next = path.dirname(current)
      if (next === current) break
      current = next
    }
  }
  return worktree
}

export function resolveFinnyWorkspacePath(filePath: string, directory: string, worktree: string): string {
  if (path.isAbsolute(filePath)) {
    if (!existsSync(filePath)) {
      const match = filePath.match(/^(.*?)[/\\]((?:algos(?:[/\\].*)?)|(?:data-agent(?:[/\\]instructions\.md)?))$/)
      if (match) {
        const candidate = path.resolve(findFinnyAlgoRoot(directory, worktree), match[2])
        if (candidate !== filePath && (existsSync(candidate) || existsSync(path.dirname(candidate)))) return candidate
      }
    }
    return filePath
  }
  const normalized = filePath.replace(/^\.\//, "")
  if (
    normalized === "algos" ||
    normalized.startsWith("algos/") ||
    normalized === "data-agent" ||
    normalized === "data-agent/instructions.md"
  ) {
    return path.resolve(findFinnyAlgoRoot(directory, worktree), normalized)
  }
  return path.resolve(directory, filePath)
}

function isRepoLocalAlgoArtifactPath(filepath: string, worktree: string, kind: "news" | "sec" | "sentiment") {
  const relative = path.relative(path.join(worktree, "algos"), filepath)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep)
  return parts.length >= 3 && parts[1] === "data" && parts[2] === kind
}

function isFlatArtifactTarget(root: string, filepath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filepath))
  if (relative === "") return true
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep).filter(Boolean)
  return parts.length === 1 && parts[0] !== "body" && parts[0] !== "headlines"
}

function isDotEnv(file: string) {
  return /^\.env(?:$|\.)/.test(path.basename(file))
}

function isWorkspaceMetadataFile(workspacePath: string, filepath: string) {
  return new Set([
    workspacePath,
    path.join(workspacePath, "mission.md"),
    path.join(workspacePath, "request.json"),
    path.join(workspacePath, "prefs.md"),
    path.join(workspacePath, "decisions.md"),
    path.join(workspacePath, "memory.md"),
    path.join(workspacePath, "CURRENT"),
  ]).has(path.resolve(filepath))
}

export function isStrategySynthesisPath(workspacePath: string, filepath: string) {
  const resolvedWorkspace = path.resolve(workspacePath)
  const resolvedFile = path.resolve(filepath)
  if (!sameOrInside(resolvedWorkspace, resolvedFile)) return false

  const relative = path.relative(resolvedWorkspace, resolvedFile)
  if (relative === "edge_analysis.md") return true
  if (new Set(["strategy.py", "config.json"]).has(relative)) return true

  const parts = relative.split(path.sep)
  if (!/^v\d+$/i.test(parts[0] ?? "")) return false
  if (parts.length !== 2) return false
  return parts[1] === "strategy.py" || /^config(?:\.[^.]+)?\.json$/i.test(parts[1] ?? "")
}

function blocked(code: string, message: string): FinnyWorkspacePolicyResult {
  return { allowed: false, code, message }
}

async function evaluateDataAgentReadPolicy(
  input: FinnyWorkspacePolicyInput,
  filepath: string,
): Promise<FinnyWorkspacePolicyResult> {
  if (isDotEnv(filepath)) {
    return blocked(
      "data_agent_env_blocked",
      `Data Agent read blocked: may not read ${path.basename(filepath)} because env files are not model-visible.`,
    )
  }
  const root = findFinnyAlgoRoot(input.directory, input.worktree)
  if (sameOrInside(path.join(root, "data-agent"), filepath)) return { allowed: true }
  const workspace = await getSessionWorkspace(input.sessionID).catch(() => null)
  const workspacePath = workspace ? algoDir(workspace) : undefined
  if (workspacePath && isWorkspaceMetadataFile(workspacePath, filepath)) return { allowed: true }
  if (workspacePath && sameOrInside(path.join(workspacePath, "data"), filepath)) return { allowed: true }
  const allowedHint = workspacePath ? path.join(workspacePath, "data") : "the session workspace data/ directory"
  return blocked(
    "data_agent_path_blocked",
    `Data Agent read blocked: ${filepath} is outside allowed data roots. Read the cookbook at ${path.join(root, "data-agent", "instructions.md")} and inspect artifacts under ${allowedHint}.`,
  )
}

async function evaluateMainFinnyWritePolicy(
  input: FinnyWorkspacePolicyInput,
  filepath: string,
): Promise<FinnyWorkspacePolicyResult> {
  const workspace = await getSessionWorkspace(input.sessionID).catch(() => null)
  if (!workspace) return { allowed: true }
  const workspaceRoot = algoDir(workspace)
  if (!sameOrInside(workspaceRoot, filepath)) {
    return blocked(
      "finny_strategy_write_outside_workspace",
      `Finny ${input.operation} blocked: ${filepath} is outside the bound strategy workspace ${workspaceRoot}. During a strategy workflow, the main Finny agent may write only durable strategy artifacts inside that workspace; it may not modify repository source, scripts, or unrelated filesystem paths.`,
    )
  }
  const dataRoot = path.join(workspaceRoot, "data")
  if (!sameOrInside(dataRoot, filepath)) return { allowed: true }
  return blocked(
    "finny_workspace_data_write_blocked",
    `Finny ${input.operation} blocked: ${filepath} is a tool-owned evidence artifact under ${dataRoot}. The main Finny agent may read workspace data, but only the owning subagent or evidence finalizer may write it. Relaunch clean evidence collection when identity or lineage does not match.`,
  )
}

function allowUnboundArtifactRead(input: FinnyWorkspacePolicyInput, filepath: string, kind: ArtifactKind): boolean {
  if (input.operation !== "read") return false
  return !isRepoLocalAlgoArtifactPath(filepath, input.worktree, kind)
}

function unboundArtifactResult(
  input: FinnyWorkspacePolicyInput,
  filepath: string,
  kind: ArtifactKind,
  label: string,
): FinnyWorkspacePolicyResult {
  if (allowUnboundArtifactRead(input, filepath, kind)) return { allowed: true }
  return blocked(
    `${kind}_workspace_unbound`,
    `${label} ${input.operation} blocked: ${filepath} is not allowed because no ${WORKSPACE_BINDINGS[kind]} is bound.`,
  )
}

function requiresFlatArtifactTarget(input: FinnyWorkspacePolicyInput, kind: ArtifactKind): boolean {
  if (!(["news", "sentiment"] as ArtifactKind[]).includes(kind)) return false
  return (["write", "edit"] as FinnyWorkspaceOperation[]).includes(input.operation)
}

function nestedArtifactResult(
  input: FinnyWorkspacePolicyInput,
  filepath: string,
  root: string,
  kind: ArtifactKind,
  label: string,
): FinnyWorkspacePolicyResult {
  const instruction =
    kind === "news"
      ? `write one compact markdown note directly under ${root}`
      : `write aggregate artifacts directly under ${root}`
  return blocked(
    `${kind}_nested_write_blocked`,
    `${label} ${input.operation} blocked: ${instruction}; do not use body/ or headlines/ subfolders.`,
  )
}

async function evaluateArtifactAgentPolicy(
  input: FinnyWorkspacePolicyInput,
  filepath: string,
  kind: ArtifactKind,
): Promise<FinnyWorkspacePolicyResult> {
  const label = AGENT_LABELS[input.agent ?? ""] ?? "Artifact Agent"
  const workspace = await getSessionWorkspace(input.sessionID).catch(() => null)
  if (!workspace) return unboundArtifactResult(input, filepath, kind, label)

  const root = path.join(algoDir(workspace), "data", kind)
  if (!sameOrInside(root, filepath)) {
    return blocked(
      `${kind}_path_blocked`,
      `${label} ${input.operation} blocked: ${filepath} is outside the session workspace ${ARTIFACT_NOUNS[kind]} directory. Use ${root}.`,
    )
  }
  if (requiresFlatArtifactTarget(input, kind) && !isFlatArtifactTarget(root, filepath)) {
    return nestedArtifactResult(input, filepath, root, kind, label)
  }
  return { allowed: true }
}

/**
 * Single source of truth for Finny agent file access. Direct tools and the
 * observational harness before-hook both call this function.
 */
export async function evaluateFinnyWorkspacePathPolicy(
  input: FinnyWorkspacePolicyInput,
): Promise<FinnyWorkspacePolicyResult> {
  const filepath = resolveFinnyWorkspacePath(input.filePath, input.directory, input.worktree)
  const isDataRead = input.agent === "data_extractor" && input.operation === "read"
  if (isDataRead) return evaluateDataAgentReadPolicy(input, filepath)

  const isMainFinnyWrite = input.agent === "finny" && input.operation !== "read"
  if (isMainFinnyWrite) return evaluateMainFinnyWritePolicy(input, filepath)

  const kind = ARTIFACT_KIND_BY_AGENT[input.agent ?? ""]
  if (!kind) return { allowed: true }
  return evaluateArtifactAgentPolicy(input, filepath, kind)
}

export const assertFinnyWorkspacePathPolicy = Effect.fn("FinnyWorkspaceGuard.assertPathPolicy")(function* (
  ctx: Tool.Context,
  filePath: string,
  operation: FinnyWorkspaceOperation,
  database?: Database.Interface,
) {
  const instance = yield* InstanceState.context
  const filepath = resolveFinnyWorkspacePath(filePath, instance.directory, instance.worktree)
  const result = yield* Effect.promise(() =>
    evaluateFinnyWorkspacePathPolicy({
      agent: ctx.agent,
      sessionID: ctx.sessionID,
      filePath: filepath,
      operation,
      directory: instance.directory,
      worktree: instance.worktree,
    }),
  )
  if (!result.allowed) return yield* Effect.die(new FinnyWorkspacePolicyError(result))

  if (ctx.agent !== "finny" || operation === "read") return
  const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
  if (!workspace || !isStrategySynthesisPath(algoDir(workspace), filepath)) return

  const pending = yield* Effect.promise(() => StrategyContext.pendingTasks(ctx.sessionID, database, ctx.messages))
  if (pending.length === 0) return
  return yield* Effect.die(
    new FinnyWorkspacePolicyError({
      code: "strategy_context_pending",
      message: StrategyContext.blockedOutput(`Writing ${path.basename(filepath)}`, pending),
    }),
  )
})
