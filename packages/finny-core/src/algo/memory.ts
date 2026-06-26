import fs from "node:fs/promises"
import path from "node:path"
import {
  MEMORY_FILE,
  MISSION_FILE,
  CURRENT_FILE,
  REASONING_FILE,
  PROGRESS_FILE,
  FINNY_DIR,
  parseCurrent,
} from "./schemas"
import { algoDir, algosRoot } from "./paths"

/**
 * Building blocks for the future opencode compaction plugin:
 *
 *   - buildCompactionContext(): bundles mission + CURRENT + reasoning so
 *     the plugin can inject them into `output.context` before the
 *     compaction prompt fires.
 *
 *   - appendMemoryEntry(): the handler the future `finny_record_memory`
 *     tool will call after the compaction model emits its summary. Writes
 *     a fresh dated block to <algo>/memory.md.
 *
 * Both are pure file-system helpers — no opencode imports — so they're
 * testable in isolation and the plugin can be a thin shim over them.
 */

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/** A persisted subagent handoff summary (e.g. the data or news subagent's findings). */
export interface SubagentSummary {
  /** Stable kind label, e.g. "data" or "news". */
  kind: string
  body: string
}

export interface CompactionContext {
  algo: string
  algoDir: string
  /** mission.md contents, or "" if not written yet. */
  mission: string
  /** Active version (e.g. "v01"), or null before the first strategy is saved. */
  current: string | null
  reasoning: string | null
  /** Latest persisted data/news subagent summaries, oldest filename first. */
  subagentSummaries: SubagentSummary[]
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8")
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

/**
 * Read everything the compaction prompt needs about the active algo. Tolerant
 * of an early-session workspace where mission.md is only a placeholder and the
 * CURRENT/version files do not exist yet (the agent has not saved v1) — in that
 * case `current`/`reasoning` are null but any gathered subagent summaries are
 * still returned so they can be re-handed across compaction.
 */
export async function buildCompactionContext(
  algoName: string,
  root: string = algosRoot(),
): Promise<CompactionContext> {
  const dir = algoDir(algoName, root)
  const mission = (await readOptional(path.join(dir, MISSION_FILE))) ?? ""
  const currentRaw = await readOptional(path.join(dir, CURRENT_FILE))
  const current = currentRaw !== null ? parseCurrent(currentRaw) : null
  let reasoning: string | null = null
  if (current) {
    reasoning = await readOptional(path.join(dir, current, REASONING_FILE))
  }
  const subagentSummaries = await readSubagentSummaries(algoName, root)
  return { algo: algoName, algoDir: dir, mission, current, reasoning, subagentSummaries }
}

/**
 * Map an opencode subagent_type to the stable kind label used for its
 * persisted handoff summary. Data extraction -> "data"; news/research/exec
 * context -> "news"; SEC filings -> "sec". Returns null for subagent types we
 * do not persist a handoff summary for.
 */
export function subagentKind(subagentType: string): string | null {
  switch (subagentType) {
    case "data_extractor":
      return "data"
    case "news_agent":
    case "researcher":
      return "news"
    case "sec_agent":
      return "sec"
    default:
      return null
  }
}

/**
 * Persist a subagent's returned summary to `<algo>/.finny/<kind>-summary.md`
 * (latest wins). These survive compaction so the post-compaction agent can be
 * re-handed the data/news context it gathered earlier in the session.
 */
export async function writeSubagentSummary(
  algoName: string,
  kind: string,
  body: string,
  root: string = algosRoot(),
): Promise<string> {
  const dir = path.join(algoDir(algoName, root), FINNY_DIR)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${kind}-summary.md`)
  await fs.writeFile(file, body.trim() + "\n", "utf8")
  return file
}

/** Read all persisted `<kind>-summary.md` handoff files, sorted by filename. */
export async function readSubagentSummaries(
  algoName: string,
  root: string = algosRoot(),
): Promise<SubagentSummary[]> {
  const dir = path.join(algoDir(algoName, root), FINNY_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err: any) {
    if (err?.code === "ENOENT") return []
    throw err
  }
  const out: SubagentSummary[] = []
  for (const name of entries.sort()) {
    const match = /^(.+)-summary\.md$/.exec(name)
    if (!match) continue
    const body = (await fs.readFile(path.join(dir, name), "utf8")).trim()
    if (body) out.push({ kind: match[1], body })
  }
  return out
}

export interface MemoryEntry {
  active_version: string
  summary: string
  open_threads?: string[]
  /** Defaults to today. Override for deterministic tests. */
  date?: string
}

function renderEntry(entry: MemoryEntry): string {
  const date = entry.date ?? isoDate()
  const threads = entry.open_threads && entry.open_threads.length > 0
    ? entry.open_threads.map((t) => `  - ${t.replace(/\s+/g, " ").trim()}`).join("\n")
    : "  - (none)"
  const summary = entry.summary.trim()
  return [
    ``,
    `## ${date} — compaction`,
    `- active version: ${entry.active_version}`,
    `- since last compaction: ${summary}`,
    `- open threads:`,
    threads,
    ``,
  ].join("\n")
}

/**
 * Append a dated compaction block to <algo>/memory.md. Idempotency is the
 * caller's responsibility — this always appends.
 */
export async function appendMemoryEntry(
  algoName: string,
  entry: MemoryEntry,
  root: string = algosRoot(),
): Promise<string> {
  const dir = algoDir(algoName, root)
  const file = path.join(dir, MEMORY_FILE)
  const block = renderEntry(entry)
  await fs.appendFile(file, block, "utf8")
  return file
}

/** Exposed for tests. */
export const _renderEntry = renderEntry

/**
 * Append a free-form compaction summary block to memory.md. Use this when
 * the source is opencode's compaction model output (which has its own
 * structure — ## Goal, ## Instructions, etc.) and we want to preserve it
 * verbatim rather than squeeze it into the structured `MemoryEntry` shape.
 */
export async function appendCompactionSummary(
  algoName: string,
  input: { active_version: string; body: string; date?: string },
  root: string = algosRoot(),
): Promise<string> {
  const dir = algoDir(algoName, root)
  const file = path.join(dir, MEMORY_FILE)
  const date = input.date ?? isoDate()
  const block = [
    ``,
    `## ${date} — compaction (${input.active_version})`,
    ``,
    input.body.trim(),
    ``,
  ].join("\n")
  await fs.appendFile(file, block, "utf8")
  return file
}

export interface ProgressTimeline {
  algo: string
  version: string
  /** Ordered, human-readable step labels (e.g. "Launched data subagent"). */
  steps: string[]
  /** Defaults to today. Override for deterministic tests. */
  date?: string
}

/**
 * Render a small "what's been done so far" timeline as Markdown. This is the
 * quick-glance progress view surfaced on `/compact` and persisted to
 * `<algo>/progress.md` — distinct from the full compaction summary in memory.md.
 */
export function renderProgressTimeline(input: ProgressTimeline): string {
  const date = input.date ?? isoDate()
  const lines = input.steps.length
    ? input.steps.map((s) => `- ${s.replace(/\s+/g, " ").trim()}`)
    : ["- (no recorded steps yet)"]
  return [
    `# Progress — ${input.algo}`,
    ``,
    `_Updated ${date} · current version ${input.version}_`,
    ``,
    ...lines,
    ``,
  ].join("\n")
}

/** Write (overwrite) the latest progress snapshot to `<algo>/progress.md`. */
export async function writeProgress(
  algoName: string,
  body: string,
  root: string = algosRoot(),
): Promise<string> {
  const file = path.join(algoDir(algoName, root), PROGRESS_FILE)
  await fs.writeFile(file, body.trimEnd() + "\n", "utf8")
  return file
}

/** Exposed for tests. */
export const _renderProgressTimeline = renderProgressTimeline
