import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { resolveReadPath } from "../../src/tool/read"

const REPO_ROOT = "/Users/dev/finny-internal-prop"
const PKG_DIR = path.join(REPO_ROOT, "packages/opencode")

describe("resolveReadPath", () => {
  test("anchors relative algos/_template paths at the worktree root, not the package dir", () => {
    const resolved = resolveReadPath("algos/_template/README.md", PKG_DIR, REPO_ROOT)
    expect(resolved).toBe(path.join(REPO_ROOT, "algos/_template/README.md"))
    expect(resolved).not.toContain("packages/opencode")
  })

  test("handles a leading ./ on algos paths", () => {
    const resolved = resolveReadPath("./algos/_template/data/spy.md", PKG_DIR, REPO_ROOT)
    expect(resolved).toBe(path.join(REPO_ROOT, "algos/_template/data/spy.md"))
  })

  test("finds the Finny algos root above a nested packages/opencode cwd", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "finny-read-root-"))
    try {
      mkdirSync(path.join(root, "algos/_template"), { recursive: true })
      mkdirSync(path.join(root, "packages/opencode"), { recursive: true })
      writeFileSync(path.join(root, "algos/_template/README.md"), "# Template\n")

      const nested = path.join(root, "packages/opencode")
      const resolved = resolveReadPath("algos/_template/README.md", nested, nested)

      expect(resolved).toBe(path.join(root, "algos/_template/README.md"))
      expect(resolved).not.toContain("packages/opencode/algos")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("leaves other relative paths anchored at the working directory", () => {
    const resolved = resolveReadPath("src/tool/read.ts", PKG_DIR, REPO_ROOT)
    expect(resolved).toBe(path.join(PKG_DIR, "src/tool/read.ts"))
  })

  test("passes absolute paths through unchanged", () => {
    const abs = "/tmp/whatever/file.md"
    expect(resolveReadPath(abs, PKG_DIR, REPO_ROOT)).toBe(abs)
  })

  test("does not treat a substring match like algos-other as the algos root", () => {
    const resolved = resolveReadPath("algos-archive/x.md", PKG_DIR, REPO_ROOT)
    expect(resolved).toBe(path.join(PKG_DIR, "algos-archive/x.md"))
  })
})

describe("resolveReadPath absolute wrong-base remap", () => {
  // The BTC session errors: the model composed absolute paths under
  // packages/opencode (its cwd context) — read of .../packages/opencode/algos/
  // _template/README.md, write of a data brief under the same wrong base.
  function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "finny-remap-"))
    mkdirSync(path.join(root, "algos/_template/data/news"), { recursive: true })
    mkdirSync(path.join(root, "packages/opencode"), { recursive: true })
    writeFileSync(path.join(root, "algos/_template/README.md"), "# Template\n")
    return { root, nested: path.join(root, "packages/opencode") }
  }

  test("remaps a wrong-base absolute read to the algo root when the target exists there", () => {
    const { root, nested } = fixture()
    try {
      const wrong = path.join(nested, "algos/_template/README.md")
      expect(resolveReadPath(wrong, nested, nested)).toBe(path.join(root, "algos/_template/README.md"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("remaps a wrong-base bare directory read", () => {
    const { root, nested } = fixture()
    try {
      const wrong = path.join(nested, "algos/_template")
      expect(resolveReadPath(wrong, nested, nested)).toBe(path.join(root, "algos/_template"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("remaps a wrong-base absolute write of a NEW file when the parent dir exists at the root", () => {
    const { root, nested } = fixture()
    try {
      const wrong = path.join(nested, "algos/_template/data/news/btc-brief.md")
      expect(resolveReadPath(wrong, nested, nested)).toBe(path.join(root, "algos/_template/data/news/btc-brief.md"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("never remaps an absolute path that exists where it points", () => {
    const { root, nested } = fixture()
    try {
      const real = path.join(nested, "algos/real.md")
      mkdirSync(path.dirname(real), { recursive: true })
      writeFileSync(real, "x")
      expect(resolveReadPath(real, nested, nested)).toBe(real)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("leaves unrelated missing absolute paths untouched", () => {
    const { root, nested } = fixture()
    try {
      const missing = path.join(nested, "src/nothing.ts")
      expect(resolveReadPath(missing, nested, nested)).toBe(missing)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
