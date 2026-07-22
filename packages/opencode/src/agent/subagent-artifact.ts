import fs from "node:fs/promises"
import path from "node:path"
import { algoDir, DATA_NEWS_DIR, DATA_SEC_DIR } from "@finny-ai/core/algo"
import { summarizeNewsClaimsForPointer } from "@/data/news-evidence"

/** Workspace data dirs each non-data_extractor subagent writes its brief into. */
const SUBAGENT_DIRS: Record<string, string[]> = {
  news_agent: [DATA_NEWS_DIR],
  researcher: [DATA_NEWS_DIR],
  sec_agent: [DATA_SEC_DIR],
  sentiment_agent: ["data/sentiment"],
}

const MAX_FILES = 3

async function collectFiles(absDir: string): Promise<{ abs: string; mtime: number }[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: { abs: string; mtime: number }[] = []
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(abs)))
    } else if (entry.isFile() && /\.(md|json|csv)$/i.test(entry.name)) {
      try {
        out.push({ abs, mtime: (await fs.stat(abs)).mtimeMs })
      } catch {
        // ignore unreadable entries
      }
    }
  }
  return out
}

async function firstHeading(absFile: string): Promise<string | undefined> {
  if (!absFile.endsWith(".md")) return undefined
  try {
    const content = await fs.readFile(absFile, "utf8")
    const heading = content.split("\n").find((line) => /^#{1,3}\s+\S/.test(line))
    return heading?.replace(/^#{1,3}\s+/, "").trim()
  } catch {
    return undefined
  }
}

async function newsClaimsLine(absFile: string, subagentType: string): Promise<string | undefined> {
  if (subagentType !== "news_agent" && subagentType !== "researcher") return undefined
  try {
    const content = await fs.readFile(absFile, "utf8")
    return summarizeNewsClaimsForPointer(content) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build a pointer block listing the brief file(s) a non-data_extractor subagent
 * wrote, so the parent agent reliably sees what was produced (path + heading)
 * and can read it without re-running the subagent. Returns "" when nothing was
 * written or the subagent type has no tracked output dir.
 *
 * For news_agent / researcher files, also append per-file evidence counts or
 * NO_SOURCED_CONTEXT from the finny.news.claims.v1 block when present.
 */
export async function renderSubagentArtifactPointer(subagentType: string, workspaceSlug: string): Promise<string> {
  const dirs = SUBAGENT_DIRS[subagentType]
  if (!dirs) return ""

  const root = algoDir(workspaceSlug)
  const files: { abs: string; mtime: number }[] = []
  for (const dir of dirs) files.push(...(await collectFiles(path.join(root, dir))))
  if (files.length === 0) return ""

  files.sort((a, b) => b.mtime - a.mtime)
  const top = files.slice(0, MAX_FILES)

  const entries: string[] = []
  for (const f of top) {
    const rel = path.relative(root, f.abs).replaceAll(path.sep, "/")
    const heading = await firstHeading(f.abs)
    const claims = await newsClaimsLine(f.abs, subagentType)
    const lines = [`- file: ${rel}`]
    if (heading) lines.push(`  heading: ${heading}`)
    if (claims) lines.push(`  ${claims}`)
    entries.push(lines.join("\n"))
  }
  return [`<subagent-artifact agent="${subagentType}">`, ...entries, "</subagent-artifact>"].join("\n")
}
