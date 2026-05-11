import fs from "node:fs/promises"
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

export async function loadUserPrefs(p: string = userPrefsPath()): Promise<ParsedUserPrefs | null> {
  try {
    const raw = await fs.readFile(p, "utf8")
    return parseUserPrefs(raw)
  } catch (err: any) {
    if (err?.code === "ENOENT") return null
    throw err
  }
}

export async function writeUserPrefs(
  prefs: ParsedUserPrefs,
  p: string = userPrefsPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, serializeUserPrefs(prefs), "utf8")
}

export async function setExperienceLevel(
  level: ExperienceLevel,
  p: string = userPrefsPath(),
): Promise<ParsedUserPrefs> {
  const existing = await loadUserPrefs(p)
  const next: ParsedUserPrefs = {
    frontmatter: {
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
  return (await loadUserPrefs(p)) !== null
}

export { userDataRoot }
