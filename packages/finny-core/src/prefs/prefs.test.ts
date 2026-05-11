import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  UserPrefs,
  isOnboarded,
  loadUserPrefs,
  parseUserPrefs,
  serializeUserPrefs,
  setExperienceLevel,
  userDataRoot,
  userPrefsPath,
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
    expect(userPrefsPath({ XDG_DATA_HOME: "/x/data" } as any, "darwin")).toBe(
      path.join("/x/data", "finny", "prefs.md"),
    )
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
})
