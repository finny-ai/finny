import { Effect } from "effect"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import { bootstrapWorkspace } from "@/plugin/finny-workspace"
import { parseRequestFacts } from "@/agent/request-identity"
import {
  ensureResearchBrief,
  inspectResearchBrief,
  readWorkspaceRequestIdentity,
  researchBriefMatchesFacts,
  restoreRequestIdentityFromBrief,
  updateResearchBrief,
} from "@/agent/research-brief"
import { syncWorkspaceRequestContext } from "@/agent/finny-workspace-context"
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
  researchOnly?: boolean
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

export function extractPromptText(message: { parts: { type: string; text?: string; synthetic?: boolean }[] }): string {
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

function loadBoundResearchHandoff(input: PreflightInput) {
  return Effect.tryPromise({
    try: async () => {
      const slug = await getSessionWorkspace(input.sessionID)
      if (!slug) return undefined
      const workspacePath = algoDir(slug)
      const status = await inspectResearchBrief(workspacePath)
      if (!status.exists) return undefined
      const facts = parseRequestFacts(input.prompt)
      // Build prompt that adds/changes identity vs an existing brief must fail closed —
      // never silently reuse the workspace without an approved matching handoff.
      if (status.brief && !researchBriefMatchesFacts(status.brief, facts)) {
        throw new Error(
          "Build blocked by ResearchBrief: request identity does not match the research handoff (re-run Research or restate the approved identity)",
        )
      }
      if (status.brief?.transition === "approved" && status.buildReady) {
        await restoreRequestIdentityFromBrief({ workspacePath, brief: status.brief })
      }
      return { slug, workspacePath, status: await inspectResearchBrief(workspacePath) }
    },
    catch: asError,
  })
}

function bootstrapResearchWorkspace(input: PreflightInput) {
  return Effect.tryPromise({
    try: async () => {
      const existingSlug = await getSessionWorkspace(input.sessionID)
      if (existingSlug) {
        const existingPath = algoDir(existingSlug)
        const existingStatus = await inspectResearchBrief(existingPath)
        if (existingStatus.exists && !existingStatus.brief) {
          throw new Error(`ResearchBrief blocked: ${existingStatus.reason}`)
        }
        if (existingStatus.brief) {
          const context = await syncWorkspaceRequestContext({
            sessionID: input.sessionID,
            slug: existingSlug,
            prompt: input.prompt,
            facts: parseRequestFacts(input.prompt),
          })
          await updateResearchBrief({
            workspacePath: existingPath,
            identity: {
              request_id: context.request_id,
              requested_symbol: context.requested_symbol,
              requested_symbols: context.requested_symbols,
              requested_interval: context.requested_interval,
              requested_asset_class: context.requested_asset_class,
              requested_algorithm_name: context.requested_algorithm_name,
            },
          })
          return { slug: existingSlug, dir: existingPath, created: false, rebound: false }
        }
      }
      return bootstrapWorkspace(input.sessionID, input.prompt)
    },
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

    if (input.agent === "research") {
      const workspace = yield* bootstrapResearchWorkspace(input)
      if (!workspace) return undefined
      const identity = yield* Effect.tryPromise({
        try: () => readWorkspaceRequestIdentity(workspace.dir),
        catch: asError,
      })
      if (!identity) throw new Error("ResearchBrief blocked: workspace request identity is missing")
      yield* Effect.tryPromise({
        try: () => ensureResearchBrief(workspace.dir, identity),
        catch: asError,
      })
      const publish = createPreflightPublisher(input)
      yield* publish("workspace", "Research workspace ready; execution environment not provisioned", workspace.slug)
      return {
        workspaceSlug: workspace.slug,
        workspacePath: workspace.dir,
        python: "",
        pip: "",
        envDir: "",
        researchOnly: true,
      } satisfies PreflightResult
    }

    const envReadyBefore = yield* loadEnvReadyBefore(input.sessionID)
    const handoff = yield* loadBoundResearchHandoff(input)
    if (handoff && !handoff.status.buildReady) {
      throw new Error(`Build blocked by ResearchBrief: ${handoff.status.reason ?? "handoff is not ready"}`)
    }
    const workspace = handoff
      ? { slug: handoff.slug, dir: handoff.workspacePath, created: false, rebound: false }
      : yield* bootstrapSessionWorkspace(input)
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
