import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  algoDir,
  clearActiveAlgo,
  ensureAlgoWorkspace,
  getActiveAlgo,
  setActiveAlgo,
  parseMission,
  writeAlgo,
  _activeMarkerPath,
  isSlug,
  humanNameOf,
} from "./index"
import { DATA_NEWS_BODY_DIR, DATA_NEWS_HEADLINES_DIR, MISSION_FILE } from "./schemas"

const MISSION = `---
schema_version: 2
name: active-demo
status: research
created: 2026-05-17
hypothesis: |
  Test fixture.
scope:
  asset_class: crypto
  universe: [BTC]
  horizon: weeks
exit_conditions: |
  - 14d
---

# active-demo
`

let savedEnv: NodeJS.ProcessEnv
let sandbox: string
let algosRootDir: string

beforeEach(async () => {
  savedEnv = { ...process.env }
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-active-"))
  process.env.XDG_DATA_HOME = sandbox
  delete process.env.LOCALAPPDATA
  algosRootDir = path.join(sandbox, "finny", "algos")
  await fs.mkdir(algosRootDir, { recursive: true })
})

afterEach(async () => {
  process.env = savedEnv
  await fs.rm(sandbox, { recursive: true, force: true })
})

async function seedAlgo(name: string, slug?: string) {
  const m = parseMission(MISSION.replace("active-demo", name))
  await writeAlgo({
    root: algosRootDir,
    slug,
    mission: m,
    current: "v01",
    versions: { v01: { strategy: "pass\n" } },
  })
}

describe("getActiveAlgo / setActiveAlgo / clearActiveAlgo", () => {
  test("unset by default", async () => {
    expect(await getActiveAlgo({ cwd: sandbox })).toBeNull()
  })

  test("set / get round-trip with slug", async () => {
    const { slug } = await writeAlgo({
      root: algosRootDir,
      mission: parseMission(MISSION),
      current: "v01",
      versions: { v01: { strategy: "pass\n" } },
    })
    await setActiveAlgo(slug)
    expect(await getActiveAlgo()).toBe(slug)
    expect(isSlug(slug)).toBe(true)
    expect(humanNameOf(slug)).toBe("active-demo")
  })

  test("setActiveAlgo rejects an unknown algo", async () => {
    await expect(setActiveAlgo("missing-algo.abcd1234")).rejects.toThrow(/not found/)
  })

  test("setActiveAlgo rejects an invalid name", async () => {
    await expect(setActiveAlgo("BadName")).rejects.toThrow(/invalid/)
  })

  test("clearActiveAlgo is idempotent — safe when no marker exists", async () => {
    await clearActiveAlgo()
    await clearActiveAlgo()
    expect(await getActiveAlgo({ cwd: sandbox })).toBeNull()
  })

  test("marker takes precedence over cwd walk-up", async () => {
    const r1 = await writeAlgo({
      root: algosRootDir,
      mission: parseMission(MISSION.replace("active-demo", "first-algo")),
      current: "v01",
      versions: { v01: { strategy: "pass\n" } },
    })
    const r2 = await writeAlgo({
      root: algosRootDir,
      mission: parseMission(MISSION.replace("active-demo", "second-algo")),
      current: "v01",
      versions: { v01: { strategy: "pass\n" } },
    })
    await setActiveAlgo(r2.slug)
    expect(await getActiveAlgo({ cwd: r1.dir })).toBe(r2.slug)
  })

  test("walk-up fallback finds mission.md ancestor when marker is unset", async () => {
    const { slug, dir } = await writeAlgo({
      root: algosRootDir,
      mission: parseMission(MISSION.replace("active-demo", "walk-demo")),
      current: "v01",
      versions: { v01: { strategy: "pass\n" } },
    })
    const deep = path.join(dir, "v01")
    expect(await getActiveAlgo({ cwd: deep })).toBe(slug)
  })

  test("walk-up returns null when no mission.md ancestor exists", async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "no-mission-"))
    try {
      expect(await getActiveAlgo({ cwd: elsewhere })).toBeNull()
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })
})

describe("active marker storage location", () => {
  test("respects XDG_DATA_HOME on linux/darwin", () => {
    const env = { XDG_DATA_HOME: "/x/data" } as NodeJS.ProcessEnv
    expect(_activeMarkerPath(env, "darwin")).toBe(path.join("/x/data", "finny", "active-algo"))
    expect(_activeMarkerPath(env, "linux")).toBe(path.join("/x/data", "finny", "active-algo"))
  })

  test("uses LOCALAPPDATA on win32", () => {
    const env = { LOCALAPPDATA: "C:/users/me/AppData/Local" } as NodeJS.ProcessEnv
    expect(_activeMarkerPath(env, "win32")).toBe(path.join("C:/users/me/AppData/Local", "finny", "active-algo"))
  })

  test("falls back to ~/.local/share when XDG unset on linux/darwin", () => {
    const got = _activeMarkerPath({} as NodeJS.ProcessEnv, "linux")
    expect(got.endsWith(path.join(".local", "share", "finny", "active-algo"))).toBe(true)
  })
})

describe("ensureAlgoWorkspace", () => {
  test("creates dir with slug, data subtree, and placeholder mission.md on first call", async () => {
    const res = await ensureAlgoWorkspace("fresh-algo", { root: algosRootDir })
    expect(res.created).toBe(true)
    expect(isSlug(res.slug)).toBe(true)
    expect(humanNameOf(res.slug)).toBe("fresh-algo")
    expect(res.dir).toBe(algoDir(res.slug, algosRootDir))

    const missionRaw = await fs.readFile(path.join(res.dir, MISSION_FILE), "utf8")
    // Placeholder must parse against the strict frontmatter schema.
    expect(() => parseMission(missionRaw)).not.toThrow()
    // Mission stores human name, not slug
    const parsed = parseMission(missionRaw)
    expect(parsed.frontmatter.name).toBe("fresh-algo")

    await fs.stat(path.join(res.dir, DATA_NEWS_HEADLINES_DIR))
    await fs.stat(path.join(res.dir, DATA_NEWS_BODY_DIR))
  })

  test("same human name creates distinct workspaces by default", async () => {
    const res1 = await ensureAlgoWorkspace("same-name", { root: algosRootDir })
    const res2 = await ensureAlgoWorkspace("same-name", { root: algosRootDir })
    expect(res2.slug).not.toBe(res1.slug)
    expect(res2.dir).not.toBe(res1.dir)
    expect(res1.created).toBe(true)
    expect(res2.created).toBe(true)
  })

  test("distinct workspaces can be forced with an explicit slug suffix", async () => {
    const res1 = await ensureAlgoWorkspace("same-name", { root: algosRootDir, slug: "same-name.1.1.00.01" })
    const res2 = await ensureAlgoWorkspace("same-name", { root: algosRootDir, slug: "same-name.1.1.00.02" })
    expect(res1.slug).not.toBe(res2.slug)
    expect(res1.created).toBe(true)
    expect(res2.created).toBe(true)
  })

  test("idempotent when called with same slug", async () => {
    const res1 = await ensureAlgoWorkspace("my-algo", { root: algosRootDir })
    const missionPath = path.join(res1.dir, MISSION_FILE)
    const before = await fs.readFile(missionPath, "utf8")

    // Re-call with the same slug
    const res2 = await ensureAlgoWorkspace(res1.slug, { root: algosRootDir })
    expect(res2.created).toBe(false)
    expect(res2.slug).toBe(res1.slug)
    expect(res2.dir).toBe(res1.dir)

    const after = await fs.readFile(missionPath, "utf8")
    expect(after).toBe(before)
  })

  test("setActive: true marks the new workspace as the active algo", async () => {
    const res = await ensureAlgoWorkspace("active-on-create", { root: algosRootDir, setActive: true })
    expect(await getActiveAlgo()).toBe(res.slug)
  })

  test("rejects invalid kebab-case names", async () => {
    await expect(ensureAlgoWorkspace("BadName", { root: algosRootDir })).rejects.toThrow(/kebab-case/)
  })
})

describe("stale marker handling", () => {
  test("ignores marker with invalid name (returns null)", async () => {
    const marker = _activeMarkerPath()
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await fs.writeFile(marker, "Not_Kebab_Case\n", "utf8")
    // walk-up cwd has no mission.md ancestor either.
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "stale-"))
    try {
      expect(await getActiveAlgo({ cwd: elsewhere })).toBeNull()
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })

  test("ignores empty marker", async () => {
    const marker = _activeMarkerPath()
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await fs.writeFile(marker, "   \n", "utf8")
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "empty-"))
    try {
      expect(await getActiveAlgo({ cwd: elsewhere })).toBeNull()
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true })
    }
  })
})
