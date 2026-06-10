import { describe, expect, test } from "bun:test"
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
