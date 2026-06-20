import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  UserPrefs,
  clearFinnyHome,
  defaultFinnyHome,
  ensureFinnyHomeDirectory,
  finnyHomeArtifacts,
  isOnboarded,
  loadUserPrefs,
  normalizeFinnyHomePath,
  parseUserPrefs,
  resolveFinnyHome,
  serializeUserPrefs,
  setExperienceLevel,
  setFinnyHome,
  userDataRoot,
  userPrefsPath,
  writeUserPrefs,
} from "./index"

async function mkSandbox(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "finny-prefs-test-"))
}

describe("UserPrefs schema", () => {
  test("accepts a valid payload", () => {
    expect(() =>
      UserPrefs.parse({
        schema_version: 1,
        experience_level: "beginner",
        onboarded_at: "2026-05-11T14:30:00Z",
      }),
    ).not.toThrow()
  })

  test("accepts storage-only prefs before onboarding", () => {
    const prefs = UserPrefs.parse({
      schema_version: 1,
      finny_home: "/tmp/finny-home",
    })
    expect(prefs.finny_home).toBe("/tmp/finny-home")
  })

  test("rejects unknown experience_level", () => {
    expect(() =>
      UserPrefs.parse({
        schema_version: 1,
        experience_level: "quant",
        onboarded_at: "2026-05-11T14:30:00Z",
      }),
    ).toThrow()
  })

  test("rejects missing onboarded_at", () => {
    expect(() => UserPrefs.parse({ schema_version: 1, experience_level: "trader" })).toThrow()
  })
})

describe("userDataRoot / userPrefsPath", () => {
  test("respects XDG_DATA_HOME on linux/darwin", () => {
    expect(userDataRoot({ XDG_DATA_HOME: "/x/data" } as any, "darwin")).toBe(path.join("/x/data", "finny"))
    expect(userPrefsPath({ XDG_DATA_HOME: "/x/data" } as any, "darwin")).toBe(path.join("/x/data", "finny", "prefs.md"))
  })

  test("uses LOCALAPPDATA on win32", () => {
    const got = userDataRoot({ LOCALAPPDATA: "C:\\\\Local" } as any, "win32")
    expect(got).toBe(path.join("C:\\\\Local", "finny"))
  })

  test("falls back under HOME when env unset", () => {
    expect(userDataRoot({} as any, "linux").endsWith(path.join(".local", "share", "finny"))).toBe(true)
  })
})

describe("parse / serialize round-trip", () => {
  test("parses and re-serializes a valid prefs.md", () => {
    const raw =
      "---\nschema_version: 1\nexperience_level: beginner\nonboarded_at: 2026-05-11T14:30:00Z\n---\n\nFree-form notes.\n"
    const parsed = parseUserPrefs(raw)
    expect(parsed.frontmatter.experience_level).toBe("beginner")
    const reparsed = parseUserPrefs(serializeUserPrefs(parsed))
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter)
  })

  test("rejects a file without frontmatter", () => {
    expect(() => parseUserPrefs("just markdown, no frontmatter\n")).toThrow()
  })
})

describe("loadUserPrefs / writeUserPrefs / setExperienceLevel", () => {
  test("loadUserPrefs returns null when the file does not exist", async () => {
    const root = await mkSandbox()
    expect(await loadUserPrefs(path.join(root, "prefs.md"))).toBeNull()
  })

  test("isOnboarded reflects file presence", async () => {
    const root = await mkSandbox()
    const p = path.join(root, "prefs.md")
    expect(await isOnboarded(p)).toBe(false)
    await setExperienceLevel("beginner", p)
    expect(await isOnboarded(p)).toBe(true)
  })

  test("setExperienceLevel preserves onboarded_at on update", async () => {
    const root = await mkSandbox()
    const p = path.join(root, "prefs.md")
    const first = await setExperienceLevel("beginner", p)
    await new Promise((r) => setTimeout(r, 5))
    const second = await setExperienceLevel("trader", p)
    expect(second.frontmatter.experience_level).toBe("trader")
    expect(second.frontmatter.onboarded_at).toBe(first.frontmatter.onboarded_at)
  })

  test("setExperienceLevel creates parent dirs as needed", async () => {
    const root = await mkSandbox()
    const nested = path.join(root, "a", "b", "prefs.md")
    await setExperienceLevel("trader", nested)
    expect((await loadUserPrefs(nested))?.frontmatter.experience_level).toBe("trader")
  })

  test("setExperienceLevel preserves saved Finny Home", async () => {
    const root = await mkSandbox()
    const p = path.join(root, "prefs.md")
    await writeUserPrefs(
      {
        frontmatter: {
          schema_version: 1,
          finny_home: "/tmp/custom-finny",
        },
        body: "\n",
      },
      p,
    )
    await setExperienceLevel("trader", p)
    expect((await loadUserPrefs(p))?.frontmatter.finny_home).toBe("/tmp/custom-finny")
  })

  test("storage-only prefs do not mark onboarding complete", async () => {
    const root = await mkSandbox()
    const p = path.join(root, "prefs.md")
    await writeUserPrefs(
      {
        frontmatter: {
          schema_version: 1,
          finny_home: "/tmp/custom-finny",
        },
        body: "\n",
      },
      p,
    )
    expect(await isOnboarded(p)).toBe(false)
  })
})

describe("Finny Home", () => {
  test("defaults to the existing Finny data root", () => {
    const env = { XDG_DATA_HOME: "/x/data" } as NodeJS.ProcessEnv
    expect(defaultFinnyHome(env, "darwin")).toBe(path.join("/x/data", "finny"))
    expect(resolveFinnyHome({ env, platform: "darwin", prefsPath: path.join("/missing", "prefs.md") })).toEqual({
      path: path.join("/x/data", "finny"),
      source: "default",
      configurable: true,
    })
  })

  test("defaults to XDG_DATA_HOME for isolated win32 tests", () => {
    const env = {
      OPENCODE_TEST_HOME: "C:\\\\tmp\\\\test-home",
      XDG_DATA_HOME: "C:\\\\tmp\\\\xdg-data",
      LOCALAPPDATA: "C:\\\\users\\\\me\\\\AppData\\\\Local",
    } as NodeJS.ProcessEnv
    expect(defaultFinnyHome(env, "win32")).toBe(path.join("C:\\\\tmp\\\\xdg-data", "finny"))
  })

  test("FINNY_HOME overrides saved prefs and default", async () => {
    const root = await mkSandbox()
    const prefsPath = path.join(root, "prefs.md")
    await writeUserPrefs(
      {
        frontmatter: {
          schema_version: 1,
          finny_home: path.join(root, "saved"),
        },
        body: "\n",
      },
      prefsPath,
    )
    const got = resolveFinnyHome({
      env: { FINNY_HOME: path.join(root, "env"), XDG_DATA_HOME: path.join(root, "xdg") } as NodeJS.ProcessEnv,
      platform: "linux",
      prefsPath,
    })
    expect(got).toEqual({
      path: path.join(root, "env"),
      source: "env",
      configurable: false,
    })
  })

  test("saved Finny Home overrides the default when env is unset", async () => {
    const root = await mkSandbox()
    const prefsPath = path.join(root, "prefs.md")
    const saved = path.join(root, "saved")
    await writeUserPrefs(
      {
        frontmatter: {
          schema_version: 1,
          finny_home: saved,
        },
        body: "\n",
      },
      prefsPath,
    )
    expect(
      resolveFinnyHome({ env: { XDG_DATA_HOME: path.join(root, "xdg") } as any, platform: "linux", prefsPath }),
    ).toEqual({
      path: saved,
      source: "prefs",
      configurable: true,
    })
  })

  test("artifact paths live under the effective Finny Home", () => {
    const artifacts = finnyHomeArtifacts("/tmp/finny")
    expect(artifacts).toEqual({
      algos: path.join("/tmp/finny", "algos"),
      sessionWorkspaces: path.join("/tmp/finny", "session-workspaces"),
      pythonEnv: path.join("/tmp/finny", "python-env"),
      algorithms: path.join("/tmp/finny", "algorithms"),
    })
  })

  test("normalizes tilde and relative paths", async () => {
    const root = await mkSandbox()
    expect(normalizeFinnyHomePath("~/Finny", root)).toBe(path.join(root, "Finny"))
    expect(normalizeFinnyHomePath("relative-finny", root)).toBe(path.resolve("relative-finny"))
  })

  test("setFinnyHome creates the directory and clearFinnyHome restores default resolution", async () => {
    const prevFinnyHome = process.env.FINNY_HOME
    delete process.env.FINNY_HOME
    const root = await mkSandbox()
    try {
      const prefsPath = path.join(root, "prefs.md")
      const custom = path.join(root, "custom")
      const set = await setFinnyHome(custom, prefsPath)
      expect(set.path).toBe(custom)
      expect(set.source).toBe("prefs")
      expect((await fs.stat(custom)).isDirectory()).toBe(true)

      const cleared = await clearFinnyHome(prefsPath)
      expect(cleared.source).toBe("default")
      expect((await loadUserPrefs(prefsPath))?.frontmatter.finny_home).toBeUndefined()
    } finally {
      if (prevFinnyHome === undefined) delete process.env.FINNY_HOME
      else process.env.FINNY_HOME = prevFinnyHome
    }
  })

  test("ensureFinnyHomeDirectory rejects file paths", async () => {
    const root = await mkSandbox()
    const file = path.join(root, "file")
    await fs.writeFile(file, "not a directory")
    await expect(ensureFinnyHomeDirectory(file)).rejects.toThrow("Finny Home must be a directory")
  })
})
