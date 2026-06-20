import { Effect } from "effect"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import { bootstrapWorkspace } from "@/plugin/finny-workspace"
import {
  isWorkspaceEnvReady,
  resolveWorkspacePythonEnv,
  SESSION_PREFLIGHT_PACKAGES,
  workspaceEnvDir,
} from "@/python/session-env"
import { Python } from "@/python/env"
import type { SessionID } from "./schema"
import type { PreflightPhase } from "./status"
import { SessionStatus } from "./status"

export const PREFLIGHT_AGENTS = new Set(["build", "research"])

export interface PreflightResult {
  workspaceSlug: string
  workspacePath: string
  python: string
  pip: string
  envDir: string
}

export interface PreflightInput {
  sessionID: SessionID
  agent: string
  prompt: string
  setStatus: (status: SessionStatus.Info) => Effect.Effect<void>
}

function userPromptText(parts: { type: string; text?: string; synthetic?: boolean }[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic)
    .map((p) => p.text as string)
    .join("\n")
    .trim()
}

export function extractPromptText(message: {
  parts: { type: string; text?: string; synthetic?: boolean }[]
}): string {
  return userPromptText(message.parts)
}

function phaseForProgressMessage(message: string): PreflightPhase {
  if (message.includes("Installing")) return "install"
  if (message.includes("ready")) return "ready"
  return "python"
}

function preflightResultForWorkspace(slug: string): PreflightResult {
  const workspacePath = algoDir(slug)
  const envDir = workspaceEnvDir(workspacePath)
  return {
    workspaceSlug: slug,
    workspacePath,
    python: Python.pythonBinForEnvDir(envDir),
    pip: Python.pipBinForEnvDir(envDir),
    envDir,
  }
}

function shouldRunPreflight(agent: string): boolean {
  return PREFLIGHT_AGENTS.has(agent) && process.env.FINNY_DISABLE_SESSION_PREFLIGHT !== "1"
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function createPreflightPublisher(input: PreflightInput) {
  const steps: string[] = []
  return (phase: PreflightPhase, message: string, workspaceSlug?: string) => {
    if (message === "Preparing workspace…") steps.length = 0
    if (steps.length === 0 || steps[steps.length - 1] !== message) steps.push(message)
    return input.setStatus({
      type: "preflight",
      phase,
      message,
      workspaceSlug,
      steps: [...steps],
    })
  }
}

function bootstrapSessionWorkspace(input: PreflightInput) {
  return Effect.tryPromise({
    try: () => bootstrapWorkspace(input.sessionID, input.prompt),
    catch: asError,
  })
}

type PreflightPublish = ReturnType<typeof createPreflightPublisher>
type BootstrappedWorkspace = NonNullable<Awaited<ReturnType<typeof bootstrapWorkspace>>>

function loadEnvReadyBefore(sessionID: SessionID) {
  return Effect.tryPromise({
    try: async () => {
      const slug = await getSessionWorkspace(sessionID)
      return slug ? isWorkspaceEnvReady(algoDir(slug), SESSION_PREFLIGHT_PACKAGES) : false
    },
    catch: asError,
  })
}

function publishWorkspaceSetup(publish: PreflightPublish, workspace: BootstrappedWorkspace) {
  const label = workspace.created ? `Created workspace ${workspace.slug}` : `Using workspace ${workspace.slug}`
  return Effect.gen(function* () {
    yield* publish("workspace", "Preparing workspace…")
    yield* publish("workspace", label, workspace.slug)
  })
}

function resolveSessionEnv(publish: PreflightPublish, workspace: BootstrappedWorkspace) {
  return Effect.tryPromise({
    try: () =>
      resolveWorkspacePythonEnv(workspace.dir, SESSION_PREFLIGHT_PACKAGES, (message) => {
        void Effect.runPromise(publish(phaseForProgressMessage(message), message, workspace.slug)).catch(
          () => undefined,
        )
      }),
    catch: asError,
  })
}

export function runFinnyPreflight(input: PreflightInput) {
  return Effect.gen(function* () {
    if (!shouldRunPreflight(input.agent)) return undefined

    const envReadyBefore = yield* loadEnvReadyBefore(input.sessionID)
    const workspace = yield* bootstrapSessionWorkspace(input)
    if (!workspace) return undefined

    const reused = !workspace.created && !workspace.rebound
    if (reused && envReadyBefore) return preflightResultForWorkspace(workspace.slug)

    const publish = createPreflightPublisher(input)
    if (!reused) yield* publishWorkspaceSetup(publish, workspace)

    yield* publish("python", "Setting up Python environment…", workspace.slug)
    const env = yield* resolveSessionEnv(publish, workspace)
    yield* publish("ready", "Environment ready", workspace.slug)

    return {
      workspaceSlug: workspace.slug,
      workspacePath: workspace.dir,
      python: env.python,
      pip: env.pip,
      envDir: env.envDir,
    } satisfies PreflightResult
  })
}

export function workspaceVenvPath(workspacePath: string): string {
  return workspaceEnvDir(workspacePath)
}
