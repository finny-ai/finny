import fs from "node:fs/promises"
import path from "node:path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  algoDir,
  bindSessionWorkspace,
  ensureAlgoWorkspace,
  getSessionWorkspace,
  isValidAlgoId,
} from "@finny-ai/core/algo"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import { parseRequestFacts, workspaceMatchesRequest, type RequestFacts } from "../agent/request-identity"
import { syncWorkspaceRequestContext } from "../agent/finny-workspace-context"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin.finny-workspace" })
const STRATEGY_ORIGIN_FILE = ".strategy-origin"

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

const CONTINUATION_RE =
  /\b(continue|pick\s+up|where\s+you\s+left\s+off|tighten|save\s+it|run\s+(the\s+)?backtest|backtest\s+it|update\s+(the\s+)?stops?|fix\s+(the\s+)?strategy|validate\s+it)\b/i

const RESEARCH_RE =
  /\b(search|look\s+up|find\s+out|news|headline|ipo|earnings|current\s+event|latest\s+on|what(?:'s|\s+is)\s+happening|status\s+of|when\s+is|who\s+is|tell\s+me\s+about)\b/i

const EXPLICIT_RESEARCH_RE =
  /\b(search|look\s+up|find\s+out|news|headline|ipo|earnings|current\s+event|latest(?:\s+on)?|what(?:'s|\s+is)\s+happening|status\s+of|when\s+is|who\s+is)\b/i

const STRATEGY_REFERENCE_RE =
  /\b(strategy|algo(?:rithm)?|backtest|entry|exit|signal|stops?|risk|position\s+sizing)\b/i

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
  [/options/i, "options"],
  [/algo(rithm)?/i, "algo"],
]

export function deriveIntent(prompt: string): string | undefined {
  for (const [re, name] of INTENT_PATTERNS) {
    if (re.test(prompt)) return name
  }
  return undefined
}

export function hasStrategyContinuationIntent(prompt: string): boolean {
  return CONTINUATION_RE.test(prompt)
}

export function isNewsResearchPrompt(prompt: string): boolean {
  return RESEARCH_RE.test(prompt)
}

export function deriveResearchWorkspaceName(prompt: string): string {
  return joinWorkspaceParts([derivePromptSlug(prompt), "research"])
}

function researchSlugBase(slug: string): string {
  return (slug.split(".")[0] ?? slug).toLowerCase()
}

function existingResearchSlugMatches(slug: string, researchName: string): boolean {
  const base = researchSlugBase(slug)
  return base === researchName || base.startsWith(`${researchName}-`)
}

function isResearchWorkspace(slug: string): boolean {
  return researchSlugBase(slug).endsWith("-research")
}

async function readStrategyOrigin(researchSlug: string): Promise<string | null> {
  try {
    const origin = (await fs.readFile(path.join(algoDir(researchSlug), STRATEGY_ORIGIN_FILE), "utf8")).trim()
    return isValidAlgoId(origin) ? origin : null
  } catch {
    return null
  }
}

async function writeStrategyOrigin(researchDir: string, strategySlug: string | null): Promise<void> {
  if (!strategySlug || isResearchWorkspace(strategySlug)) return
  await fs.writeFile(path.join(researchDir, STRATEGY_ORIGIN_FILE), `${strategySlug}\n`, "utf8")
}

function isExistingStrategyFollowup(existing: string | null, prompt: string): boolean {
  if (!existing || isResearchWorkspace(existing)) return false
  return STRATEGY_REFERENCE_RE.test(prompt) && !EXPLICIT_RESEARCH_RE.test(prompt)
}

export function derivePromptSlug(prompt: string): string {
  const stop = new Set([
    "a",
    "an",
    "the",
    "for",
    "and",
    "with",
    "build",
    "create",
    "make",
    "new",
    "me",
    "help",
    "is",
    "on",
    "of",
    "about",
    "tell",
    "search",
    "latest",
  ])
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !stop.has(word))
    .slice(0, 3)
  return (words.join("-") || "session").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")
}

/** Kebab-case workspace name from request facts, e.g. "spy-15m-mean-reversion" or "options-algo-strategy". */
export function deriveWorkspaceName(facts: RequestFacts, intent?: string, prompt = ""): string {
  const tail = intent ?? "strategy"
  const symbol = facts.requested_symbol?.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  if (symbol) {
    const parts = [symbol]
    if (facts.requested_interval) parts.push(facts.requested_interval)
    parts.push(tail)
    return joinWorkspaceParts(parts)
  }

  const slug = derivePromptSlug(prompt)
  const parts = [slug]
  if (facts.requested_interval) parts.push(facts.requested_interval)
  if (intent && !slug.includes(intent)) parts.push(intent)
  else parts.push("strategy")
  return joinWorkspaceParts(parts)
}

function joinWorkspaceParts(parts: string[]): string {
  return parts
    .join("-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
}

function slugMatchesRequest(slug: string, facts: RequestFacts): boolean {
  if (!workspaceMatchesRequest(slug, facts)) return false
  const sym = facts.requested_symbol?.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  if (!sym) return true
  const base = (slug.split(".")[0] ?? slug).toLowerCase()
  return base.includes(sym)
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
  const existing = await getSessionWorkspace(sessionID)
  const strategyOrigin = existing && isResearchWorkspace(existing) ? await readStrategyOrigin(existing) : null
  const continuation = hasStrategyContinuationIntent(prompt)
  const strategyFollowup = isExistingStrategyFollowup(strategyOrigin ?? existing, prompt)
  const research = isNewsResearchPrompt(prompt) && !continuation && !strategyFollowup && !deriveIntent(prompt)

  if (!research && strategyOrigin && (continuation || strategyFollowup)) {
    await bindSessionWorkspace(sessionID, strategyOrigin)
    await syncWorkspaceRequestContext({ sessionID, slug: strategyOrigin, prompt, facts })
    return { slug: strategyOrigin, dir: algoDir(strategyOrigin), created: false, rebound: true }
  }

  if (research) {
    const researchName = deriveResearchWorkspaceName(prompt)
    if (existing && existingResearchSlugMatches(existing, researchName)) {
      await syncWorkspaceRequestContext({ sessionID, slug: existing, prompt, facts })
      return { slug: existing, dir: algoDir(existing), created: false, rebound: false }
    }

    const ensured = await ensureAlgoWorkspace(researchName)
    await writeStrategyOrigin(ensured.dir, strategyOrigin ?? existing)
    await bindSessionWorkspace(sessionID, ensured.slug)
    await syncWorkspaceRequestContext({ sessionID, slug: ensured.slug, prompt, facts })
    return { slug: ensured.slug, dir: ensured.dir, created: ensured.created, rebound: Boolean(existing) }
  }

  if (existing && slugMatchesRequest(existing, facts)) {
    await syncWorkspaceRequestContext({ sessionID, slug: existing, prompt, facts })
    return { slug: existing, dir: algoDir(existing), created: false, rebound: false }
  }

  const name = deriveWorkspaceName(facts, deriveIntent(prompt), prompt)

  // Never pass setActive — the machine-global marker stays untouched.
  const ensured = await ensureAlgoWorkspace(name)
  await bindSessionWorkspace(sessionID, ensured.slug)

  // request.json and placeholder mission.md are the workspace identity ground
  // truth before the strategy is authored.
  await syncWorkspaceRequestContext({ sessionID, slug: ensured.slug, prompt, facts })

  return { slug: ensured.slug, dir: ensured.dir, created: ensured.created, rebound: Boolean(existing) }
}

// ── Session consolidation ────────────────────────────────────────────────────
// A session writes data into its workspace while the final algorithm identity is
// unknown. Once saved, data moves under the named saved-algorithm folder.

interface ManifestEntry {
  name: string
  algorithmId: string
  latest_version: number
  store_path: string
  updated: string
}

/**
 * Link a saved algorithm into the session workspace and move the workspace data
 * tree into the saved algorithm store. Finder users can then open
 * `<workspace>/algorithms/<name>` and see data beside the saved versions.
 */
export async function linkAlgorithmToWorkspace(
  sessionID: string,
  meta: { algorithmId: string; name: string; version: number },
): Promise<string | undefined> {
  const slug = await getSessionWorkspace(sessionID)
  if (!slug) return undefined
  const wsDir = algoDir(slug)
  const storePath = path.join(finnyArtifactPath("algorithms"), meta.algorithmId)

  const linksDir = path.join(wsDir, "algorithms")
  await fs.mkdir(linksDir, { recursive: true })
  const linkPath = path.join(linksDir, meta.name)
  await fs.rm(linkPath, { force: true }).catch(() => {})
  await fs.symlink(storePath, linkPath)

  await moveWorkspaceDataToAlgorithmStore(wsDir, storePath).catch(() => undefined)

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

async function moveWorkspaceDataToAlgorithmStore(workspaceDir: string, storePath: string): Promise<string | undefined> {
  const src = path.join(workspaceDir, "data")
  const dest = path.join(storePath, "data")
  try {
    const stat = await fs.stat(src)
    if (!stat.isDirectory()) return undefined
  } catch {
    return undefined
  }

  await fs.mkdir(storePath, { recursive: true })
  await fs.cp(src, dest, { recursive: true, force: true, errorOnExist: false })
  await normalizeFlatArtifactFolders(dest)
  await fs.rm(src, { recursive: true, force: true })
  return dest
}

async function normalizeFlatArtifactFolders(dataRoot: string): Promise<void> {
  for (const artifactKind of ["news", "sentiment"]) {
    await normalizeFlatArtifactKind(dataRoot, artifactKind)
  }
}

async function normalizeFlatArtifactKind(dataRoot: string, artifactKind: string): Promise<void> {
  const root = path.join(dataRoot, artifactKind)
  await fs.mkdir(root, { recursive: true })
  for (const legacy of ["body", "headlines"]) {
    await flattenLegacyArtifactFolder(root, legacy)
  }
}

async function flattenLegacyArtifactFolder(root: string, legacy: string): Promise<void> {
  const legacyRoot = path.join(root, legacy)
  const files = await listFiles(legacyRoot)
  for (const file of files) {
    await copyFileToFlatArtifactRoot(file, root)
  }
  await fs.rm(legacyRoot, { recursive: true, force: true }).catch(() => undefined)
}

async function copyFileToFlatArtifactRoot(file: string, root: string): Promise<void> {
  const dest = path.join(root, path.basename(file))
  if (path.resolve(file) === path.resolve(dest)) return
  const exists = await fs
    .stat(dest)
    .then(() => true)
    .catch(() => false)
  if (!exists) await fs.copyFile(file, dest)
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const entry of entries) {
    const child = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(child)))
    else if (entry.isFile()) out.push(child)
  }
  return out
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
  const dest = path.join(wsDir, "data", "news", path.basename(m[1]))
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(filePath, dest)
  return dest
}

export async function FinnyWorkspacePlugin(_input: PluginInput): Promise<Hooks> {
  return {
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
