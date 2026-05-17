import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  algoDir,
  clearActiveAlgo,
  getActiveAlgo,
  setActiveAlgo,
  parseMission,
  writeAlgo,
  _activeMarkerPath,
} from "./index"

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

async function seedAlgo(name: string) {
  const m = parseMission(MISSION.replace("active-demo", name))
  await writeAlgo({
    root: algosRootDir,
    mission: m,
    current: "v01",
    versions: { v01: { strategy: "pass\n" } },
  })
}

describe("getActiveAlgo / setActiveAlgo / clearActiveAlgo", () => {
  test("unset by default", async () => {
    expect(await getActiveAlgo({ cwd: sandbox })).toBeNull()
  })

  test("set / get round-trip", async () => {
    await seedAlgo("active-demo")
    await setActiveAlgo("active-demo")
    expect(await getActiveAlgo()).toBe("active-demo")
  })

  test("setActiveAlgo rejects an unknown algo", async () => {
    await expect(setActiveAlgo("missing-algo")).rejects.toThrow(/not found/)
  })

  test("setActiveAlgo rejects an invalid name (not kebab-case)", async () => {
    await expect(setActiveAlgo("BadName")).rejects.toThrow(/kebab-case/)
  })

  test("clearActiveAlgo is idempotent — safe when no marker exists", async () => {
    await clearActiveAlgo()
    await clearActiveAlgo()
    expect(await getActiveAlgo({ cwd: sandbox })).toBeNull()
  })

  test("marker takes precedence over cwd walk-up", async () => {
    await seedAlgo("first-algo")
    await seedAlgo("second-algo")
    await setActiveAlgo("second-algo")
    const inFirst = algoDir("first-algo", algosRootDir)
    expect(await getActiveAlgo({ cwd: inFirst })).toBe("second-algo")
  })

  test("walk-up fallback finds mission.md ancestor when marker is unset", async () => {
    await seedAlgo("walk-demo")
    const deep = path.join(algoDir("walk-demo", algosRootDir), "v01")
    expect(await getActiveAlgo({ cwd: deep })).toBe("walk-demo")
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
