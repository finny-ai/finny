import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import {
  ARCHIVE_DIR,
  BACKTEST_FILE,
  Backtest,
  CURRENT_FILE,
  DATA_SUBDIRS,
  DECISIONS_FILE,
  MEMORY_FILE,
  MISSION_FILE,
  MissionFrontmatter,
  PREFS_FILE,
  REASONING_FILE,
  STRATEGY_FILE,
  VERSION_DIR_RE,
  parseCurrent,
  humanNameOf,
  isSlug,
  makeSlug,
} from "./schemas"
import { algoDir, algosRoot, discoverAlgos, discoverVersions, resolveAlgoDir, versionDir } from "./paths"

export * from "./schemas"
export * from "./paths"
export * from "./active"
export * from "./memory"

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const DEFAULT_MEMORY_SEED = (name: string) =>
  `# Memory: ${name}\n\n<!-- Append-only. Agent writes via finny_record_memory on /compact. Humans: edit decisions.md instead. -->\n`

export interface ParsedMission {
  frontmatter: MissionFrontmatter
  body: string
}

export function parseMission(raw: string): ParsedMission {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) throw new Error("mission.md missing YAML frontmatter (`---` fenced block at start)")
  const fm = YAML.parse(m[1]!)
  return { frontmatter: MissionFrontmatter.parse(fm), body: m[2] ?? "" }
}

export function serializeMission(mission: ParsedMission): string {
  const fm = YAML.stringify(mission.frontmatter).trimEnd()
  const body = mission.body.startsWith("\n") ? mission.body : "\n" + mission.body
  return `---\n${fm}\n---${body}`
}

export interface AlgoVersion {
  name: string
  dir: string
  strategy(): Promise<string>
  backtest(): Promise<Backtest | null>
  reasoning(): Promise<string | null>
}

export interface Algo {
  /** The slug (e.g. `btc-mean-reversion-1h.a3f8c9e2`) or legacy plain name. */
  name: string
  /** Human-readable name extracted from the slug. */
  displayName: string
  dir: string
  mission: ParsedMission
  current: string
  versions: string[]
  decisions(): Promise<string>
  memory(): Promise<string>
  prefs(): Promise<string>
  archive(): Promise<string[]>
  version(name?: string): AlgoVersion
}

async function readOptional(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8")
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

function buildVersion(algoRoot: string, version: string): AlgoVersion {
  if (!VERSION_DIR_RE.test(version)) throw new Error(`invalid version name: ${version}`)
  const dir = path.join(algoRoot, version)
  return {
    name: version,
    dir,
    async strategy() {
      return await fs.readFile(path.join(dir, STRATEGY_FILE), "utf8")
    },
    async backtest() {
      const raw = await readOptional(path.join(dir, BACKTEST_FILE))
      if (raw === null) return null
      return Backtest.parse(JSON.parse(raw))
    },
    async reasoning() {
      return await readOptional(path.join(dir, REASONING_FILE))
    },
  }
}

/**
 * Load an algo by slug or human name.
 * - Slug: used directly (e.g. `btc-mean-reversion-1h.a3f8c9e2`)
 * - Human name: resolved via `resolveAlgoDir` (glob for `<name>.*` or legacy exact match)
 */
export async function loadAlgo(nameOrSlug: string, root: string = algosRoot()): Promise<Algo> {
  let dir: string
  let slug: string

  if (isSlug(nameOrSlug)) {
    slug = nameOrSlug
    dir = algoDir(slug, root)
  } else {
    const resolved = await resolveAlgoDir(nameOrSlug, root)
    dir = resolved.dir
    slug = resolved.slug
  }

  const missionRaw = await fs.readFile(path.join(dir, MISSION_FILE), "utf8")
  const mission = parseMission(missionRaw)
  const displayName = humanNameOf(slug)

  // Mission frontmatter stores the human name, not the slug
  if (mission.frontmatter.name !== displayName) {
    throw new Error(
      `mission.name (${mission.frontmatter.name}) does not match folder name (${slug}) at ${dir}`,
    )
  }
  const currentRaw = await fs.readFile(path.join(dir, CURRENT_FILE), "utf8")
  const current = parseCurrent(currentRaw)
  const versions = await discoverVersions(slug, root)
  return {
    name: slug,
    displayName,
    dir,
    mission,
    current,
    versions,
    async decisions() {
      return (await readOptional(path.join(dir, DECISIONS_FILE))) ?? ""
    },
    async memory() {
      return (await readOptional(path.join(dir, MEMORY_FILE))) ?? ""
    },
    async prefs() {
      return (await readOptional(path.join(dir, PREFS_FILE))) ?? ""
    },
    async archive() {
      try {
        const entries = await fs.readdir(path.join(dir, ARCHIVE_DIR), { withFileTypes: true })
        return entries
          .filter((e) => e.isFile() && /^chat-\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
          .map((e) => e.name)
          .sort()
      } catch (err: any) {
        if (err?.code === "ENOENT") return []
        throw err
      }
    },
    version(v?: string) {
      return buildVersion(dir, v ?? current)
    },
  }
}

export interface AlgoHeader {
  /** Slug or legacy plain name (the directory name). */
  name: string
  /** Human-readable display name. */
  displayName: string
  dir: string
  mission: ParsedMission
  current: string
}

export async function listAlgos(root: string = algosRoot()): Promise<AlgoHeader[]> {
  const names = await discoverAlgos(root)
  const out: AlgoHeader[] = []
  for (const name of names) {
    const dir = algoDir(name, root)
    try {
      const missionRaw = await fs.readFile(path.join(dir, MISSION_FILE), "utf8")
      const currentRaw = await fs.readFile(path.join(dir, CURRENT_FILE), "utf8")
      out.push({
        name,
        displayName: humanNameOf(name),
        dir,
        mission: parseMission(missionRaw),
        current: parseCurrent(currentRaw),
      })
    } catch {
      // Skip folders that don't conform; let loadAlgo surface the error if directly requested.
    }
  }
  return out
}

export async function writeAlgo(params: {
  root?: string
  /** Optional slug to use as directory name. If omitted, generates one from mission.frontmatter.name. */
  slug?: string
  mission: ParsedMission
  current: string
  decisions?: string
  memory?: string
  prefs?: string
  versions: Record<
    string,
    {
      strategy: string
      reasoning?: string
      backtest?: Backtest
    }
  >
}): Promise<{ dir: string; slug: string }> {
  const root = params.root ?? algosRoot()
  const humanName = params.mission.frontmatter.name
  const slug = params.slug ?? makeSlug(humanName)
  const dir = algoDir(slug, root)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, MISSION_FILE), serializeMission(params.mission), "utf8")
  await fs.writeFile(path.join(dir, CURRENT_FILE), parseCurrent(params.current) + "\n", "utf8")
  await fs.writeFile(path.join(dir, DECISIONS_FILE), params.decisions ?? `# Decisions log: ${humanName}\n`, "utf8")
  // memory.md is append-only. Only seed it on first creation, or overwrite
  // when an explicit `memory` arg is provided. Never clobber existing history.
  const memoryPath = path.join(dir, MEMORY_FILE)
  if (params.memory !== undefined) {
    await fs.writeFile(memoryPath, params.memory, "utf8")
  } else {
    try {
      await fs.stat(memoryPath)
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err
      await fs.writeFile(memoryPath, DEFAULT_MEMORY_SEED(humanName), "utf8")
    }
  }
  await fs.writeFile(path.join(dir, PREFS_FILE), params.prefs ?? `# Preferences: ${humanName}\n`, "utf8")
  for (const sub of DATA_SUBDIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  for (const [v, content] of Object.entries(params.versions)) {
    const vdir = versionDir(slug, v, root)
    await fs.mkdir(vdir, { recursive: true })
    await fs.writeFile(path.join(vdir, STRATEGY_FILE), content.strategy, "utf8")
    if (content.reasoning !== undefined) {
      await fs.writeFile(path.join(vdir, REASONING_FILE), content.reasoning, "utf8")
    }
    if (content.backtest !== undefined) {
      const parsed = Backtest.parse(content.backtest)
      await fs.writeFile(path.join(vdir, BACKTEST_FILE), JSON.stringify(parsed, null, 2) + "\n", "utf8")
    }
  }
  return { dir, slug }
}
