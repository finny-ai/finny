import fs from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { ALGO_NAME_RE, MISSION_FILE } from "./schemas"
import { algoDir, algosRoot } from "./paths"

/**
 * Resolution chain for "which algo is currently active":
 *   1. Explicit marker file (set by `setActiveAlgo`, written by /algo use)
 *   2. Walk up from cwd to find a mission.md ancestor
 *   3. Unset → return null (callers should no-op)
 *
 * Marker file lives next to the algos root so a single file covers all
 * sessions on the machine. This is intentionally coarse — Finny users
 * work on one algo at a time. Per-session selection is a future change
 * once an opencode session-state plumbing is in place.
 */

function activeMarkerPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA
    const base = local && local.length > 0 ? local : path.join(homedir(), "AppData", "Local")
    return path.join(base, "finny", "active-algo")
  }
  const xdg = env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".local", "share")
  return path.join(base, "finny", "active-algo")
}

async function readMarker(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<string | null> {
  const p = activeMarkerPath(env, platform)
  try {
    const raw = (await fs.readFile(p, "utf8")).trim()
    if (!raw) return null
    if (!ALGO_NAME_RE.test(raw)) return null
    return raw
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

async function walkUpForMission(start: string): Promise<string | null> {
  let dir = path.resolve(start)
  while (true) {
    try {
      await fs.stat(path.join(dir, MISSION_FILE))
      const name = path.basename(dir)
      if (ALGO_NAME_RE.test(name)) return name
      return null
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export interface ActiveAlgoOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/** Returns the name of the active algo, or null if none is selected. */
export async function getActiveAlgo(opts: ActiveAlgoOptions = {}): Promise<string | null> {
  const marker = await readMarker(opts.env, opts.platform)
  if (marker) return marker
  const cwd = opts.cwd ?? process.cwd()
  return await walkUpForMission(cwd)
}

/** Set the active algo. Validates that the algo dir actually exists. */
export async function setActiveAlgo(name: string, opts: ActiveAlgoOptions & { root?: string } = {}): Promise<void> {
  if (!ALGO_NAME_RE.test(name)) {
    throw new Error(`invalid algo name: ${JSON.stringify(name)} (must be kebab-case)`)
  }
  const root = opts.root ?? algosRoot(opts.env, opts.platform)
  const dir = algoDir(name, root)
  try {
    await fs.stat(path.join(dir, MISSION_FILE))
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(`algo "${name}" not found at ${dir} (missing mission.md)`)
    }
    throw err
  }
  const marker = activeMarkerPath(opts.env, opts.platform)
  await fs.mkdir(path.dirname(marker), { recursive: true })
  await fs.writeFile(marker, name + "\n", "utf8")
}

/** Clear the active algo marker. Idempotent. */
export async function clearActiveAlgo(opts: ActiveAlgoOptions = {}): Promise<void> {
  const marker = activeMarkerPath(opts.env, opts.platform)
  try {
    await fs.unlink(marker)
  } catch (err: any) {
    if (err?.code === "ENOENT") return
    throw err
  }
}

/** Exposed for tests + the future /algo use slash command. */
export const _activeMarkerPath = activeMarkerPath
