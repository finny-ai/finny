import fs from "node:fs/promises"
import path from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  algoDir,
  bindSessionWorkspace,
  ensureAlgoWorkspace,
  getSessionWorkspace,
} from "@finny-ai/core/algo"
import { parseRequestFacts, workspaceMatchesRequest, type RequestFacts } from "../agent/request-identity"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin.finny-workspace" })

/**
 * Per-request workspace bootstrap — the "startup script" that runs the moment
 * a prompt arrives.
 *
 * When a Build/Research prompt comes in, this plugin parses the immutable
 * request facts (symbol, interval, asset class), provisions a dedicated algo
 * workspace, and binds it to the session. Tools then resolve storage from the
 * session binding — the agent never has to decide where data lives, and a
 * stale machine-global "active algo" marker can never leak another
 * algorithm's workspace into this request (the SPY-data-in-btc-workspace bug).
 */

const BOOTSTRAP_AGENTS = new Set(["build", "research"])

/** Strategy-intent keywords, scanned in order; first hit names the workspace. */
const INTENT_PATTERNS: Array<[RegExp, string]> = [
  [/mean[\s-]?reversion|revert/i, "mean-reversion"],
  [/momentum/i, "momentum"],
  [/breakout/i, "breakout"],
  [/scalp/i, "scalping"],
  [/trend[\s-]?follow/i, "trend-following"],
  [/pairs?[\s-]trad/i, "pairs"],
  [/dca|dollar[\s-]cost/i, "dca"],
  [/swing/i, "swing"],
]

export function deriveIntent(prompt: string): string | undefined {
  for (const [re, name] of INTENT_PATTERNS) {
    if (re.test(prompt)) return name
  }
  return undefined
}

/** Kebab-case workspace name from request facts, e.g. "spy-15m-mean-reversion". */
export function deriveWorkspaceName(facts: RequestFacts, intent?: string): string | undefined {
  const symbol = facts.requested_symbol?.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  if (!symbol) return undefined
  const parts = [symbol]
  if (facts.requested_interval) parts.push(facts.requested_interval)
  parts.push(intent ?? "strategy")
  return parts
    .join("-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
}

export interface BootstrapResult {
  slug: string
  dir: string
  created: boolean
  rebound: boolean
}

/**
 * Core bootstrap: idempotent per session. Reuses the existing binding when it
 * is still consistent with the request facts; provisions + rebinds when the
 * request targets a different symbol/asset.
 */
export async function bootstrapWorkspace(
  sessionID: string,
  prompt: string,
): Promise<BootstrapResult | undefined> {
  const facts = parseRequestFacts(prompt)
  // Conceptual questions (no symbol) must not create junk workspaces.
  if (!facts.requested_symbol) return undefined

  const existing = await getSessionWorkspace(sessionID)
  if (existing && workspaceMatchesRequest(existing, facts)) {
    return { slug: existing, dir: algoDir(existing), created: false, rebound: false }
  }

  const name = deriveWorkspaceName(facts, deriveIntent(prompt))
  if (!name) return undefined

  // Never pass setActive — the machine-global marker stays untouched.
  const ensured = await ensureAlgoWorkspace(name)
  await bindSessionWorkspace(sessionID, ensured.slug)

  // request.json is the workspace's identity ground truth: subagent results
  // and artifacts are verified against these facts before use.
  const requestFile = path.join(ensured.dir, "request.json")
  await fs.writeFile(
    requestFile,
    JSON.stringify(
      {
        requested_symbol: facts.requested_symbol,
        requested_interval: facts.requested_interval,
        requested_asset_class: facts.requested_asset_class,
        request_id: sessionID,
        created: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )

  return { slug: ensured.slug, dir: ensured.dir, created: ensured.created, rebound: Boolean(existing) }
}

// ── Session consolidation ────────────────────────────────────────────────────
// Everything a session produces belongs in its one workspace: extracted data
// (handled by finny_extract_data), saved algorithms, and research notes.

interface ManifestEntry {
  name: string
  algorithmId: string
  latest_version: number
  store_path: string
  updated: string
}

/**
 * Link a saved algorithm into the session workspace: a symlink under
 * `<workspace>/algorithms/<name>` pointing at the UUID store dir, plus an
 * entry in `<workspace>/manifest.json`. Keeps the workspace the single place
 * to find every artifact the session produced without duplicating the store.
 */
export async function linkAlgorithmToWorkspace(
  sessionID: string,
  meta: { algorithmId: string; name: string; version: number },
): Promise<string | undefined> {
  const slug = await getSessionWorkspace(sessionID)
  if (!slug) return undefined
  const wsDir = algoDir(slug)
  const storePath = path.join(Global.Path.data, "algorithms", meta.algorithmId)

  const linksDir = path.join(wsDir, "algorithms")
  await fs.mkdir(linksDir, { recursive: true })
  const linkPath = path.join(linksDir, meta.name)
  await fs.rm(linkPath, { force: true }).catch(() => {})
  await fs.symlink(storePath, linkPath)

  const manifestPath = path.join(wsDir, "manifest.json")
  let manifest: { algorithms: ManifestEntry[] } = { algorithms: [] }
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
    if (!Array.isArray(manifest.algorithms)) manifest = { algorithms: [] }
  } catch {
    // first entry
  }
  const entry: ManifestEntry = {
    name: meta.name,
    algorithmId: meta.algorithmId,
    latest_version: meta.version,
    store_path: storePath,
    updated: new Date().toISOString(),
  }
  const idx = manifest.algorithms.findIndex((a) => a.algorithmId === meta.algorithmId)
  if (idx >= 0) manifest.algorithms[idx] = entry
  else manifest.algorithms.push(entry)
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
  return linkPath
}

const NEWS_PATH_RE = /[/\\]algos[/\\][^/\\]+[/\\]data[/\\]news[/\\](.+)$/

/**
 * Mirror a research note written under any `algos/<x>/data/news/...` location
 * into the session workspace's `data/news/` tree, so the workspace holds the
 * session's research even when the subagent wrote to a repo-local algo dir.
 */
export async function mirrorNewsToWorkspace(sessionID: string, filePath: string): Promise<string | undefined> {
  const m = NEWS_PATH_RE.exec(filePath)
  if (!m) return undefined
  const slug = await getSessionWorkspace(sessionID)
  if (!slug) return undefined
  const wsDir = algoDir(slug)
  if (path.resolve(filePath).startsWith(path.resolve(wsDir) + path.sep)) return undefined // already in workspace
  const dest = path.join(wsDir, "data", "news", m[1])
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(filePath, dest)
  return dest
}

export async function FinnyWorkspacePlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "chat.message": async (input, output) => {
      if (!input.agent || !BOOTSTRAP_AGENTS.has(input.agent)) return
      const text = (output.parts ?? [])
        .filter((p: any) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
        .map((p: any) => p.text as string)
        .join("\n")
      if (!text.trim()) return
      try {
        const result = await bootstrapWorkspace(input.sessionID, text)
        if (result) {
          log.info("workspace bootstrapped", {
            sessionID: input.sessionID,
            slug: result.slug,
            created: result.created,
            rebound: result.rebound,
          })
        }
      } catch (err) {
        // Bootstrap failures must never block the prompt — tools fall back to
        // provisioning a pending workspace themselves.
        log.warn("workspace bootstrap failed", {
          sessionID: input.sessionID,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        if (input.tool === "finny_algorithm_save") {
          const meta = output?.metadata
          if (meta?.algorithmId && meta?.name && typeof meta?.version === "number") {
            const link = await linkAlgorithmToWorkspace(input.sessionID, meta)
            if (link) log.info("linked saved algorithm into session workspace", { name: meta.name, link })
          }
          return
        }
        if (input.tool === "write" || input.tool === "edit") {
          const filePath = input.args?.filePath ?? input.args?.file_path
          if (typeof filePath === "string") {
            const dest = await mirrorNewsToWorkspace(input.sessionID, filePath)
            if (dest) log.info("mirrored research note into session workspace", { dest })
          }
        }
      } catch (err) {
        // Consolidation is best-effort; never fail the tool call.
        log.warn("workspace consolidation failed", {
          tool: input.tool,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
