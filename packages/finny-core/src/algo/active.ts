import fs from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import {
  ALGO_NAME_RE,
  DATA_SUBDIRS,
  MISSION_FILE,
  isValidAlgoId,
  isSlug,
  makeSlug,
  humanNameOf,
} from "./schemas"
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
    // Accept both legacy plain names and new slug format
    if (!isValidAlgoId(raw)) return null
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
      // Accept both legacy names and slug-format directory names
      if (isValidAlgoId(name)) return name
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

/** Returns the name/slug of the active algo, or null if none is selected. */
export async function getActiveAlgo(opts: ActiveAlgoOptions = {}): Promise<string | null> {
  const marker = await readMarker(opts.env, opts.platform)
  if (marker) return marker
  const cwd = opts.cwd ?? process.cwd()
  return await walkUpForMission(cwd)
}

/** Set the active algo. Accepts a slug or legacy plain name. Validates that the algo dir exists. */
export async function setActiveAlgo(nameOrSlug: string, opts: ActiveAlgoOptions & { root?: string } = {}): Promise<void> {
  if (!isValidAlgoId(nameOrSlug)) {
    throw new Error(`invalid algo identifier: ${JSON.stringify(nameOrSlug)} (must be kebab-case or kebab-case.shortid)`)
  }
  const root = opts.root ?? algosRoot(opts.env, opts.platform)
  const dir = algoDir(nameOrSlug, root)
  try {
    await fs.stat(path.join(dir, MISSION_FILE))
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(`algo "${nameOrSlug}" not found at ${dir} (missing mission.md)`)
    }
    throw err
  }
  const marker = activeMarkerPath(opts.env, opts.platform)
  await fs.mkdir(path.dirname(marker), { recursive: true })
  await fs.writeFile(marker, nameOrSlug + "\n", "utf8")
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

function placeholderMission(humanName: string): string {
  const today = new Date().toISOString().slice(0, 10)
  return [
    "---",
    "schema_version: 2",
    `name: ${humanName}`,
    "status: research",
    `created: ${today}`,
    "hypothesis: pending — workspace bootstrapped by a subagent; strategy not yet authored",
    "scope:",
    "  asset_class: mixed",
    "  universe:",
    "    - pending",
    "  horizon: days",
    "exit_conditions: pending — to be defined when the strategy is authored",
    "---",
    "",
    "<!-- Placeholder mission. Overwritten when the agent calls finny_algorithm_save. -->",
    "",
  ].join("\n")
}

export interface EnsureAlgoWorkspaceOptions extends ActiveAlgoOptions {
  root?: string
  setActive?: boolean
  /** Pass an existing slug to reuse (idempotent). If omitted, a new slug is generated. */
  slug?: string
}

/**
 * Create the on-disk workspace for an algo if it doesn't exist yet: the algo
 * dir, the `data/` subtree, and a minimal valid `mission.md` placeholder.
 *
 * Each call with a new human name generates a unique slug (`name.shortid`),
 * so two sessions building "btc-mean-reversion-1h" get separate directories.
 *
 * Idempotent when called with the same slug. Never overwrites an existing `mission.md`.
 *
 * Used by subagent-facing tools (`finny_extract_data`, `finny_research_dispatch`)
 * so the agent can dispatch research before authoring the strategy.
 */
export async function ensureAlgoWorkspace(
  nameOrSlug: string,
  opts: EnsureAlgoWorkspaceOptions = {},
): Promise<{ dir: string; slug: string; created: boolean }> {
  let slug: string

  if (isSlug(nameOrSlug)) {
    // Caller passed a full slug — reuse it (idempotent path)
    slug = nameOrSlug
  } else if (opts.slug && isSlug(opts.slug)) {
    // Caller provided a slug override
    slug = opts.slug
  } else {
    // Generate a new unique slug from the human name
    if (!ALGO_NAME_RE.test(nameOrSlug)) {
      throw new Error(`invalid algo name: ${JSON.stringify(nameOrSlug)} (must be kebab-case)`)
    }
    slug = makeSlug(nameOrSlug)
  }

  const humanName = humanNameOf(slug)
  const root = opts.root ?? algosRoot(opts.env, opts.platform)
  const dir = algoDir(slug, root)
  const missionPath = path.join(dir, MISSION_FILE)

  let created = false
  try {
    await fs.stat(missionPath)
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
    await fs.mkdir(dir, { recursive: true })
    for (const sub of DATA_SUBDIRS) {
      await fs.mkdir(path.join(dir, sub), { recursive: true })
    }
    await fs.writeFile(missionPath, placeholderMission(humanName), "utf8")
    created = true
  }

  // Ensure data subdirs even when mission already existed (cheap, idempotent).
  if (!created) {
    for (const sub of DATA_SUBDIRS) {
      await fs.mkdir(path.join(dir, sub), { recursive: true })
    }
  }

  if (opts.setActive) {
    await setActiveAlgo(slug, { env: opts.env, platform: opts.platform, root })
  }

  return { dir, slug, created }
}
