import { homedir } from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { ALGO_NAME_RE, ALGO_SLUG_RE, VERSION_DIR_RE, isValidAlgoId, humanNameOf, MISSION_FILE } from "./schemas"

const TEMPLATE_DIR = "_template"

export function algosRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA
    if (local && local.length > 0) return path.join(local, "finny", "algos")
    return path.join(homedir(), "AppData", "Local", "finny", "algos")
  }
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.length > 0) return path.join(xdg, "finny", "algos")
  return path.join(homedir(), ".local", "share", "finny", "algos")
}

/**
 * Resolve an algo identifier (slug or legacy plain name) to its directory path.
 * Synchronous — does no filesystem checks. Use `resolveAlgoDir` for name→slug lookup.
 */
export function algoDir(nameOrSlug: string, root: string = algosRoot()): string {
  if (!isValidAlgoId(nameOrSlug)) {
    throw new Error(`invalid algo identifier: ${JSON.stringify(nameOrSlug)} (must be kebab-case or kebab-case.shortid)`)
  }
  return path.join(root, nameOrSlug)
}

/**
 * Resolve a human name to an on-disk directory. Supports:
 *  - Slugs: used directly (e.g. `btc-mean-reversion-1h.a3f8c9e2`)
 *  - Legacy names: exact match (e.g. `btc-mean-reversion-1h/` exists as-is)
 *  - Slug lookup: globs `<name>.*` and picks the most recently modified
 *
 * Returns `{ dir, slug }` where slug is the directory name (may equal humanName for legacy dirs).
 */
export async function resolveAlgoDir(
  nameOrSlug: string,
  root: string = algosRoot(),
): Promise<{ dir: string; slug: string }> {
  // Already a slug — use directly
  if (ALGO_SLUG_RE.test(nameOrSlug)) {
    const dir = path.join(root, nameOrSlug)
    try {
      await fs.stat(path.join(dir, MISSION_FILE))
      return { dir, slug: nameOrSlug }
    } catch {
      throw new Error(`algo slug "${nameOrSlug}" not found at ${dir}`)
    }
  }

  if (!ALGO_NAME_RE.test(nameOrSlug)) {
    throw new Error(`invalid algo name: ${JSON.stringify(nameOrSlug)} (must be kebab-case)`)
  }

  // Legacy exact match
  const legacyDir = path.join(root, nameOrSlug)
  try {
    await fs.stat(path.join(legacyDir, MISSION_FILE))
    return { dir: legacyDir, slug: nameOrSlug }
  } catch {
    // not found — try slug glob
  }

  // Glob for <name>.* directories
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    throw new Error(`algo "${nameOrSlug}" not found (algos root missing)`)
  }

  const prefix = nameOrSlug + "."
  const matches = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith(prefix) && ALGO_SLUG_RE.test(e.name),
  )

  if (matches.length === 0) {
    throw new Error(`algo "${nameOrSlug}" not found in ${root}`)
  }

  if (matches.length === 1) {
    const dir = path.join(root, matches[0]!.name)
    try {
      await fs.stat(path.join(dir, MISSION_FILE))
    } catch {
      throw new Error(`algo "${nameOrSlug}" found at ${dir} but missing ${MISSION_FILE}`)
    }
    return { dir, slug: matches[0]!.name }
  }

  // Multiple matches — pick the most recently modified (by mission.md mtime)
  let best: import("node:fs").Dirent | null = null
  let bestMtime = 0
  for (const m of matches) {
    try {
      const st = await fs.stat(path.join(root, m.name, MISSION_FILE))
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs
        best = m
      }
    } catch {
      // skip broken entries
    }
  }
  if (!best) {
    throw new Error(`algo "${nameOrSlug}": found ${matches.length} slug directories but none contain a valid ${MISSION_FILE}`)
  }
  return { dir: path.join(root, best.name), slug: best.name }
}

export function versionDir(nameOrSlug: string, version: string, root: string = algosRoot()): string {
  return path.join(algoDir(nameOrSlug, root), version)
}

export function archiveDir(nameOrSlug: string, root: string = algosRoot()): string {
  return path.join(algoDir(nameOrSlug, root), ".archive")
}

export async function discoverAlgos(root: string = algosRoot()): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === "ENOENT") return []
    throw err
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== TEMPLATE_DIR && !e.name.startsWith(".") && isValidAlgoId(e.name))
    .map((e) => e.name)
    .sort()
}

export async function discoverVersions(nameOrSlug: string, root: string = algosRoot()): Promise<string[]> {
  const dir = algoDir(nameOrSlug, root)
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === "ENOENT") return []
    throw err
  }
  // Zero-padded vNN sorts lexicographically.
  return entries
    .filter((e) => e.isDirectory() && VERSION_DIR_RE.test(e.name))
    .map((e) => e.name)
    .sort()
}
