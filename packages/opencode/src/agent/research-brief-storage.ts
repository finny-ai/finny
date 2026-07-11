import fs from "node:fs/promises"
import path from "node:path"
import {
  PersistedResearchBriefSchema,
  RESEARCH_BRIEF_FILE,
  RESEARCH_BRIEF_SCHEMA_VERSION,
  ResearchBriefContentSchema,
  type ResearchBrief,
  type ResearchBriefContent,
  type ResearchBriefIdentity,
  type ResearchBriefStatus,
  type ResearchTransition,
} from "./research-brief-schema"
import {
  missingResearchBriefFields,
  requestIdentityConflictsBrief,
  researchBriefBlockReason,
  researchBriefIdentity,
  sameResearchIdentity,
} from "./research-brief-validation"

export interface UpdateResearchBriefInput {
  workspacePath: string
  identity: ResearchBriefIdentity
  content?: ResearchBriefContent
  transition?: ResearchTransition
  now?: Date
}

async function readJson(input: { file: string }): Promise<unknown> {
  return JSON.parse(await fs.readFile(input.file, "utf8"))
}

function briefPath(input: { workspacePath: string }): string {
  return path.join(input.workspacePath, RESEARCH_BRIEF_FILE)
}

async function writeBrief(input: { workspacePath: string; brief: ResearchBrief }): Promise<void> {
  await fs.writeFile(
    briefPath({ workspacePath: input.workspacePath }),
    JSON.stringify(input.brief, null, 2) + "\n",
    "utf8",
  )
}

export async function readResearchBrief(workspacePath: string): Promise<ResearchBrief | undefined> {
  try {
    const validated = PersistedResearchBriefSchema.safeParse(await readJson({ file: briefPath({ workspacePath }) }))
    return validated.success ? validated.data : undefined
  } catch {
    return undefined
  }
}

async function researchBriefFileExists(input: { workspacePath: string }): Promise<boolean> {
  return fs.stat(briefPath({ workspacePath: input.workspacePath })).then(
    () => true,
    () => false,
  )
}

export async function readWorkspaceRequestIdentity(workspacePath: string): Promise<ResearchBriefIdentity | undefined> {
  try {
    return researchBriefIdentity(
      (await readJson({ file: path.join(workspacePath, "request.json") })) as Record<string, unknown>,
    )
  } catch {
    return undefined
  }
}

function invalidBriefStatus(): ResearchBriefStatus {
  return {
    exists: true,
    buildReady: false,
    stale: true,
    missing: [],
    reason: "research brief is invalid or uses an unsupported schema version",
  }
}

function validBriefStatus(brief: ResearchBrief, identity?: ResearchBriefIdentity): ResearchBriefStatus {
  const stale = !identity || !sameResearchIdentity(brief.identity, identity)
  const missing = missingResearchBriefFields(brief)
  const buildReady = !stale && brief.transition === "approved" && missing.length === 0
  return {
    exists: true,
    buildReady,
    stale,
    missing,
    brief,
    reason: researchBriefBlockReason({ stale, transition: brief.transition, missing }),
  }
}

/**
 * Build-system injection: an approved complete brief remains authoritative even
 * when a sparse Build prompt rewrote request.json without restating identity.
 * Hard conflicts (e.g. request says QQQ, brief says SPY) still fail closed.
 */
export async function inspectResearchBriefForBuildHandoff(workspacePath: string): Promise<ResearchBriefStatus> {
  const brief = await readResearchBrief(workspacePath)
  if (!brief) {
    return (await researchBriefFileExists({ workspacePath }))
      ? invalidBriefStatus()
      : { exists: false, buildReady: true, stale: false, missing: [] }
  }
  const identity = await readWorkspaceRequestIdentity(workspacePath)
  const missing = missingResearchBriefFields(brief)
  if (brief.transition === "approved" && missing.length === 0) {
    if (requestIdentityConflictsBrief(brief, identity)) {
      return {
        exists: true,
        buildReady: false,
        stale: true,
        missing,
        brief,
        reason: "research brief identity does not match request.json",
      }
    }
    return {
      exists: true,
      buildReady: true,
      stale: false,
      missing,
      brief,
      reason: undefined,
    }
  }
  return validBriefStatus(brief, identity)
}

export async function inspectResearchBrief(workspacePath: string): Promise<ResearchBriefStatus> {
  const brief = await readResearchBrief(workspacePath)
  if (brief) return validBriefStatus(brief, await readWorkspaceRequestIdentity(workspacePath))
  return (await researchBriefFileExists({ workspacePath }))
    ? invalidBriefStatus()
    : { exists: false, buildReady: true, stale: false, missing: [] }
}

/** Restore request.json from an approved brief so sparse Build prompts do not orphan the handoff. */
export async function restoreRequestIdentityFromBrief(input: {
  workspacePath: string
  brief: ResearchBrief
}): Promise<void> {
  const file = path.join(input.workspacePath, "request.json")
  let previous: Record<string, unknown> = {}
  try {
    previous = (await readJson({ file })) as Record<string, unknown>
  } catch {
    previous = {}
  }
  const next = {
    ...previous,
    request_id: input.brief.identity.request_id,
    requested_symbol: input.brief.identity.requested_symbol,
    requested_symbols: input.brief.identity.requested_symbols,
    requested_interval: input.brief.identity.requested_interval,
    requested_asset_class: input.brief.identity.requested_asset_class,
    requested_algorithm_name: input.brief.identity.requested_algorithm_name,
  }
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8")
}

export async function ensureResearchBrief(
  workspacePath: string,
  identity: ResearchBriefIdentity,
  now = new Date(),
): Promise<ResearchBrief> {
  const existing = await readResearchBrief(workspacePath)
  if (existing) return existing
  const timestamp = now.toISOString()
  const brief: ResearchBrief = {
    schema_version: RESEARCH_BRIEF_SCHEMA_VERSION,
    identity,
    transition: "draft",
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
  }
  await writeBrief({ workspacePath, brief })
  return brief
}

function resolveTransition(
  requested: ResearchTransition | undefined,
  previous: ResearchTransition,
  changed: boolean,
): ResearchTransition {
  return requested ?? (changed ? "draft" : previous)
}

function assertApprovable(transition: ResearchTransition, missing: string[]): void {
  if (transition !== "approved" || missing.length === 0) return
  throw new Error(`ResearchBrief approval blocked; missing required fields: ${missing.join(", ")}`)
}

function nextResearchBrief(input: {
  previous: ResearchBrief
  identity: ResearchBriefIdentity
  content?: ResearchBriefContent
  transition: ResearchTransition
  changed: boolean
  timestamp: string
}): ResearchBrief {
  const transitioned = input.transition !== input.previous.transition
  return {
    ...input.previous,
    ...input.content,
    schema_version: RESEARCH_BRIEF_SCHEMA_VERSION,
    identity: input.identity,
    transition: input.transition,
    revision: input.previous.revision + (input.changed || transitioned ? 1 : 0),
    created_at: input.previous.created_at,
    updated_at: input.timestamp,
    approved_at: input.transition === "approved" ? input.timestamp : undefined,
  }
}

export async function updateResearchBrief(input: UpdateResearchBriefInput): Promise<ResearchBriefStatus> {
  const now = input.now ?? new Date()
  const previous = await ensureResearchBrief(input.workspacePath, input.identity, now)
  const content = input.content ? ResearchBriefContentSchema.parse(input.content) : undefined
  const changed = content !== undefined || !sameResearchIdentity(previous.identity, input.identity)
  const transition = resolveTransition(input.transition, previous.transition, changed)
  const merged = { ...previous, ...content }
  assertApprovable(transition, missingResearchBriefFields(merged))
  await writeBrief({
    workspacePath: input.workspacePath,
    brief: nextResearchBrief({
      previous,
      identity: input.identity,
      content,
      transition,
      changed,
      timestamp: now.toISOString(),
    }),
  })
  return inspectResearchBrief(input.workspacePath)
}
