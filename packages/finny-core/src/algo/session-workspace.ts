import fs from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { isValidAlgoId } from "./schemas"

/**
 * Per-session workspace binding.
 *
 * The legacy "active algo" marker (see active.ts) is machine-global: one file
 * covers every session, so a workspace selected in one session leaked into the
 * next (SPY data written into a btc-usdt-5m-momentum workspace). This store
 * binds workspace slugs to individual session IDs instead. Storage-resolving
 * tools read ONLY this binding — never the global marker.
 *
 * One file per session: `~/.local/share/finny/session-workspaces/<sessionID>`
 * containing the workspace slug. Files are tiny and cleaned up opportunistically;
 * a stale file for a dead session is harmless because session IDs are unique.
 */

export interface SessionWorkspaceOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

function bindingsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA
    const base = local && local.length > 0 ? local : path.join(homedir(), "AppData", "Local")
    return path.join(base, "finny", "session-workspaces")
  }
  const xdg = env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".local", "share")
  return path.join(base, "finny", "session-workspaces")
}

// Session IDs become filenames — restrict to a safe charset so a malformed ID
// can never traverse out of the bindings dir.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/

function bindingPath(sessionID: string, opts: SessionWorkspaceOptions = {}): string {
  if (!SESSION_ID_RE.test(sessionID)) {
    throw new Error(`invalid session id: ${JSON.stringify(sessionID)}`)
  }
  return path.join(bindingsDir(opts.env, opts.platform), sessionID)
}

/** Bind a workspace slug to a session. Overwrites any existing binding. */
export async function bindSessionWorkspace(
  sessionID: string,
  slug: string,
  opts: SessionWorkspaceOptions = {},
): Promise<void> {
  if (!isValidAlgoId(slug)) {
    throw new Error(`invalid algo identifier: ${JSON.stringify(slug)} (must be kebab-case or kebab-case.shortid)`)
  }
  const file = bindingPath(sessionID, opts)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, slug + "\n", "utf8")
}

/** Read the workspace slug bound to a session, or null if none. */
export async function getSessionWorkspace(
  sessionID: string,
  opts: SessionWorkspaceOptions = {},
): Promise<string | null> {
  let file: string
  try {
    file = bindingPath(sessionID, opts)
  } catch {
    return null
  }
  try {
    const raw = (await fs.readFile(file, "utf8")).trim()
    if (!raw || !isValidAlgoId(raw)) return null
    return raw
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

/** Remove a session's workspace binding. Idempotent. */
export async function clearSessionWorkspace(
  sessionID: string,
  opts: SessionWorkspaceOptions = {},
): Promise<void> {
  let file: string
  try {
    file = bindingPath(sessionID, opts)
  } catch {
    return
  }
  try {
    await fs.unlink(file)
  } catch (err: any) {
    if (err?.code === "ENOENT") return
    throw err
  }
}

/** Exposed for tests. */
export const _sessionWorkspaceBindingsDir = bindingsDir
