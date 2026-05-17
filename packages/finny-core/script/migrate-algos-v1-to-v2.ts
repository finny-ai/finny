#!/usr/bin/env bun
/**
 * One-shot migration: algo schema v1 -> v2.
 *
 * Per-algo changes (all idempotent — safe to re-run):
 *   - rename `vN/` -> `vNN/` (zero-pad to two digits)
 *   - rename `vNN/notes.md` -> `vNN/reasoning.md`
 *   - create `memory.md` with the seeded header if missing
 *   - create `data/{stock,crypto,sec,news/headlines,news/body}/` if missing
 *   - rewrite `CURRENT` to padded form
 *   - bump `mission.md` frontmatter `schema_version: 1 -> 2`
 *   - in any `vNN/backtest.json`: bump `schema_version` and pad `version`
 *
 * Usage:
 *   bun run packages/finny-core/script/migrate-algos-v1-to-v2.ts
 *   bun run packages/finny-core/script/migrate-algos-v1-to-v2.ts --root /tmp/fixture
 *   bun run packages/finny-core/script/migrate-algos-v1-to-v2.ts --dry-run
 */

import fs from "node:fs/promises"
import path from "node:path"
import { algosRoot, discoverAlgos, DATA_SUBDIRS } from "../src/algo"

const OLD_VERSION_RE = /^v([1-9][0-9]*)$/
const NEW_VERSION_RE = /^v(?:0[1-9]|[1-9][0-9])$/
const OLD_NOTES = "notes.md"
const NEW_REASONING = "reasoning.md"

function padVersion(name: string): string {
  const m = OLD_VERSION_RE.exec(name)
  if (!m) return name
  const n = Number(m[1])
  if (n > 99) throw new Error(`version ${name} exceeds v99; manual intervention required`)
  return "v" + String(n).padStart(2, "0")
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch (err: any) {
    if (err?.code === "ENOENT") return false
    throw err
  }
}

interface Changes {
  algo: string
  actions: string[]
}

async function migrateAlgo(root: string, name: string, dry: boolean): Promise<Changes> {
  const dir = path.join(root, name)
  const actions: string[] = []
  const exec = async (label: string, fn: () => Promise<unknown>) => {
    actions.push(label)
    if (!dry) await fn()
  }

  // 1. Rename old version dirs to padded form.
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const renames: Array<[string, string]> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (NEW_VERSION_RE.test(entry.name)) continue
    if (OLD_VERSION_RE.test(entry.name)) {
      const target = padVersion(entry.name)
      if (target !== entry.name) renames.push([entry.name, target])
    }
  }
  for (const [from, to] of renames) {
    const fromAbs = path.join(dir, from)
    const toAbs = path.join(dir, to)
    if (await exists(toAbs)) {
      throw new Error(`cannot rename ${fromAbs} -> ${toAbs}: target already exists`)
    }
    await exec(`rename ${from}/ -> ${to}/`, () => fs.rename(fromAbs, toAbs))
  }

  // 2. For each version dir, rename notes.md and migrate backtest.json.
  // In dry-run mode the rename above did NOT happen, so we must consult both
  // the on-disk listing AND the planned-rename map to report all actions.
  const renameMap = new Map(renames)
  const onDisk = await fs.readdir(dir, { withFileTypes: true })
  const versionsToVisit = new Map<string, string>() // <effective padded name> -> <actual dir name>
  for (const entry of onDisk) {
    if (!entry.isDirectory()) continue
    if (NEW_VERSION_RE.test(entry.name)) {
      versionsToVisit.set(entry.name, entry.name)
    } else if (renameMap.has(entry.name)) {
      // In dry-run, the rename hasn't happened; still report what would migrate.
      versionsToVisit.set(renameMap.get(entry.name)!, entry.name)
    }
  }
  for (const [padded, actual] of versionsToVisit) {
    const vdir = path.join(dir, actual)
    const notes = path.join(vdir, OLD_NOTES)
    const reasoning = path.join(vdir, NEW_REASONING)
    if ((await exists(notes)) && !(await exists(reasoning))) {
      await exec(`rename ${padded}/${OLD_NOTES} -> ${padded}/${NEW_REASONING}`, () =>
        fs.rename(notes, reasoning),
      )
    }
    const btPath = path.join(vdir, "backtest.json")
    if (await exists(btPath)) {
      const raw = await fs.readFile(btPath, "utf8")
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        actions.push(`! ${padded}/backtest.json: invalid JSON, skipped`)
        continue
      }
      let changed = false
      if (parsed.schema_version === 1) {
        parsed.schema_version = 2
        changed = true
      }
      if (typeof parsed.version === "string" && OLD_VERSION_RE.test(parsed.version)) {
        parsed.version = padVersion(parsed.version)
        changed = true
      }
      if (changed) {
        await exec(`bump ${padded}/backtest.json (schema_version, version)`, () =>
          fs.writeFile(btPath, JSON.stringify(parsed, null, 2) + "\n", "utf8"),
        )
      }
    }
  }

  // 3. memory.md seed.
  const memoryPath = path.join(dir, "memory.md")
  if (!(await exists(memoryPath))) {
    const seed = `# Memory: ${name}\n\n<!-- Append-only. Agent writes via finny_record_memory on /compact. Humans: edit decisions.md instead. -->\n`
    await exec("create memory.md", () => fs.writeFile(memoryPath, seed, "utf8"))
  }

  // 4. data/ skeleton.
  for (const sub of DATA_SUBDIRS) {
    const p = path.join(dir, sub)
    if (!(await exists(p))) {
      await exec(`mkdir ${sub}`, () => fs.mkdir(p, { recursive: true }))
    }
  }

  // 5. Rewrite CURRENT to padded form.
  const currentPath = path.join(dir, "CURRENT")
  if (await exists(currentPath)) {
    const cur = (await fs.readFile(currentPath, "utf8")).trim()
    if (OLD_VERSION_RE.test(cur)) {
      const padded = padVersion(cur)
      await exec(`CURRENT: ${cur} -> ${padded}`, () => fs.writeFile(currentPath, padded + "\n", "utf8"))
    }
  }

  // 6. mission.md schema_version: 1 -> 2 (frontmatter only — never touch body).
  const missionPath = path.join(dir, "mission.md")
  if (await exists(missionPath)) {
    const raw = await fs.readFile(missionPath, "utf8")
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
    if (fmMatch && /^schema_version:\s*1\b/m.test(fmMatch[1]!)) {
      const newFm = fmMatch[1]!.replace(/^schema_version:\s*1\b/m, "schema_version: 2")
      const next = raw.slice(0, fmMatch.index) + "---\n" + newFm + "\n---" + raw.slice(fmMatch.index + fmMatch[0].length)
      await exec("mission.md: schema_version 1 -> 2", () => fs.writeFile(missionPath, next, "utf8"))
    }
  }

  return { algo: name, actions }
}

async function main() {
  const args = process.argv.slice(2)
  let root = algosRoot()
  let dry = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--root") {
      const next = args[i + 1]
      if (!next || next.startsWith("-")) {
        throw new Error("--root requires a non-flag path value")
      }
      root = next
      i++
    } else if (a === "--dry-run") {
      dry = true
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: migrate-algos-v1-to-v2.ts [--root <dir>] [--dry-run]")
      process.exit(0)
    } else {
      throw new Error(`unknown arg: ${a}`)
    }
  }

  console.log(`${dry ? "[dry-run] " : ""}Migrating algos under: ${root}`)
  const names = await discoverAlgos(root)
  if (names.length === 0) {
    console.log("(no algos found)")
    return
  }

  let totalActions = 0
  for (const name of names) {
    const { actions } = await migrateAlgo(root, name, dry)
    if (actions.length === 0) {
      console.log(`  ${name}: already v2 (no changes)`)
    } else {
      console.log(`  ${name}:`)
      for (const a of actions) console.log(`    - ${a}`)
      totalActions += actions.length
    }
  }
  console.log(`\n${dry ? "[dry-run] would apply" : "applied"} ${totalActions} action(s) across ${names.length} algo(s)`)
}

main().catch((err) => {
  console.error("migration failed:", err)
  process.exit(1)
})
