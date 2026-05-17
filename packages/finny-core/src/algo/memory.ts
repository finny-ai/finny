import fs from "node:fs/promises"
import path from "node:path"
import { MEMORY_FILE, MISSION_FILE, CURRENT_FILE, REASONING_FILE, parseCurrent } from "./schemas"
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

export interface CompactionContext {
  algo: string
  algoDir: string
  mission: string
  current: string
  reasoning: string | null
}

/** Read everything the compaction prompt needs about the active algo. */
export async function buildCompactionContext(
  algoName: string,
  root: string = algosRoot(),
): Promise<CompactionContext> {
  const dir = algoDir(algoName, root)
  const mission = await fs.readFile(path.join(dir, MISSION_FILE), "utf8")
  const current = parseCurrent(await fs.readFile(path.join(dir, CURRENT_FILE), "utf8"))
  let reasoning: string | null = null
  try {
    reasoning = await fs.readFile(path.join(dir, current, REASONING_FILE), "utf8")
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
  }
  return { algo: algoName, algoDir: dir, mission, current, reasoning }
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
