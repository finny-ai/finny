import fs from "node:fs/promises"
import fsSync from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import YAML from "yaml"
import { ExperienceLevel, UserPrefs } from "./schemas"
import { userDataRoot, userPrefsPath } from "./paths"

export * from "./schemas"
export * from "./paths"

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export interface ParsedUserPrefs {
  frontmatter: UserPrefs
  body: string
}

export type FinnyHomeSource = "env" | "prefs" | "default"

export interface ResolvedFinnyHome {
  path: string
  source: FinnyHomeSource
  configurable: boolean
}

export interface FinnyHomeArtifactPaths {
  algos: string
  sessionWorkspaces: string
  pythonEnv: string
  algorithms: string
}

export interface FinnyHomeInfo extends ResolvedFinnyHome {
  defaultPath: string
  prefsPath: string
  artifacts: FinnyHomeArtifactPaths
}

export interface FinnyHomeOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  prefsPath?: string
}

export function parseUserPrefs(raw: string): ParsedUserPrefs {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) throw new Error("prefs.md missing YAML frontmatter (`---` fenced block at start)")
  const fm = YAML.parse(m[1]!)
  return { frontmatter: UserPrefs.parse(fm), body: m[2] ?? "" }
}

export function serializeUserPrefs(prefs: ParsedUserPrefs): string {
  const fm = YAML.stringify(prefs.frontmatter).trimEnd()
  const body = prefs.body.startsWith("\n") ? prefs.body : "\n" + prefs.body
  return `---\n${fm}\n---${body}`
}

export function expandHome(input: string, home: string = homedir()): string {
  if (input === "~") return home
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2))
  return input
}

function isWindowsAbsolute(input: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(input) || /^\\\\/.test(input)
}

export function normalizeFinnyHomePath(input: string, home: string = homedir()): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("Finny Home path cannot be empty")
  const expanded = expandHome(trimmed, home)
  if (isWindowsAbsolute(expanded)) return expanded
  return path.resolve(expanded)
}

export function defaultFinnyHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" && env.OPENCODE_TEST_HOME && env.XDG_DATA_HOME) {
    return path.join(env.XDG_DATA_HOME, "finny")
  }
  const root = userDataRoot(env, platform)
  return platform === "win32" ? root : path.resolve(root)
}

export async function loadUserPrefs(p: string = userPrefsPath()): Promise<ParsedUserPrefs | null> {
  try {
    const raw = await fs.readFile(p, "utf8")
    return parseUserPrefs(raw)
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

export function loadUserPrefsSync(p: string = userPrefsPath()): ParsedUserPrefs | null {
  try {
    const raw = fsSync.readFileSync(p, "utf8")
    return parseUserPrefs(raw)
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

export async function writeUserPrefs(prefs: ParsedUserPrefs, p: string = userPrefsPath()): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, serializeUserPrefs(prefs), "utf8")
}

function prefsPathForOptions(options: FinnyHomeOptions = {}): string {
  return options.prefsPath ?? userPrefsPath(options.env, options.platform)
}

export function resolveFinnyHome(options: FinnyHomeOptions = {}): ResolvedFinnyHome {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const envValue = env.FINNY_HOME?.trim()
  if (envValue) {
    return {
      path: normalizeFinnyHomePath(envValue),
      source: "env",
      configurable: false,
    }
  }

  const shouldReadPrefs =
    options.prefsPath !== undefined ||
    ((options.env === undefined || options.env === process.env) &&
      (options.platform === undefined || options.platform === process.platform))
  const prefs = shouldReadPrefs ? loadUserPrefsSync(prefsPathForOptions(options)) : null
  const saved = prefs?.frontmatter.finny_home?.trim()
  if (saved) {
    return {
      path: normalizeFinnyHomePath(saved),
      source: "prefs",
      configurable: true,
    }
  }

  return {
    path: defaultFinnyHome(env, platform),
    source: "default",
    configurable: true,
  }
}

export function finnyHomeArtifacts(home: string = resolveFinnyHome().path): FinnyHomeArtifactPaths {
  return {
    algos: path.join(home, "algos"),
    sessionWorkspaces: path.join(home, "session-workspaces"),
    pythonEnv: path.join(home, "python-env"),
    algorithms: path.join(home, "algorithms"),
  }
}

export function finnyArtifactPath(name: keyof FinnyHomeArtifactPaths, options: FinnyHomeOptions = {}): string {
  return finnyHomeArtifacts(resolveFinnyHome(options).path)[name]
}

export async function ensureFinnyHomeDirectory(input: string): Promise<string> {
  const normalized = normalizeFinnyHomePath(input)
  try {
    const stat = await fs.stat(normalized)
    if (!stat.isDirectory()) {
      throw new Error(`Finny Home must be a directory: ${normalized}`)
    }
    return normalized
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
  }
  await fs.mkdir(normalized, { recursive: true })
  const stat = await fs.stat(normalized)
  if (!stat.isDirectory()) {
    throw new Error(`Finny Home must be a directory: ${normalized}`)
  }
  return normalized
}

export async function getFinnyHomeInfo(options: FinnyHomeOptions = {}): Promise<FinnyHomeInfo> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const resolved = resolveFinnyHome(options)
  const defaultPath = defaultFinnyHome(env, platform)
  return {
    ...resolved,
    defaultPath,
    prefsPath: prefsPathForOptions(options),
    artifacts: finnyHomeArtifacts(resolved.path),
  }
}

export async function setFinnyHome(input: string, p: string = userPrefsPath()): Promise<FinnyHomeInfo> {
  if (process.env.FINNY_HOME?.trim()) {
    throw new Error("Finny Home is controlled by FINNY_HOME")
  }
  const finnyHome = await ensureFinnyHomeDirectory(input)
  const existing = await loadUserPrefs(p)
  const next: ParsedUserPrefs = {
    frontmatter: {
      ...(existing?.frontmatter ?? { schema_version: 1 }),
      finny_home: finnyHome,
    },
    body: existing?.body ?? "\n",
  }
  await writeUserPrefs(next, p)
  return getFinnyHomeInfo({ prefsPath: p })
}

export async function clearFinnyHome(p: string = userPrefsPath()): Promise<FinnyHomeInfo> {
  if (process.env.FINNY_HOME?.trim()) {
    throw new Error("Finny Home is controlled by FINNY_HOME")
  }
  const existing = await loadUserPrefs(p)
  if (existing) {
    const { finny_home: _, ...frontmatter } = existing.frontmatter
    await writeUserPrefs(
      {
        frontmatter,
        body: existing.body,
      },
      p,
    )
  }
  return getFinnyHomeInfo({ prefsPath: p })
}

export async function setExperienceLevel(
  level: ExperienceLevel,
  p: string = userPrefsPath(),
): Promise<ParsedUserPrefs> {
  const existing = await loadUserPrefs(p)
  const next: ParsedUserPrefs = {
    frontmatter: {
      ...(existing?.frontmatter ?? {}),
      schema_version: 1,
      experience_level: level,
      onboarded_at: existing?.frontmatter.onboarded_at ?? new Date().toISOString(),
    },
    body: existing?.body ?? "\n",
  }
  await writeUserPrefs(next, p)
  return next
}

export async function isOnboarded(p: string = userPrefsPath()): Promise<boolean> {
  const prefs = await loadUserPrefs(p)
  return prefs?.frontmatter.experience_level !== undefined && prefs.frontmatter.onboarded_at !== undefined
}

export { userDataRoot }
