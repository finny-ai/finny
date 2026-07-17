import { describe, expect, test } from "bun:test"
import path from "node:path"
import { localDevelopmentDatabase } from "../../script/dev"

describe("localDevelopmentDatabase", () => {
  test("is stable for the same checkout", () => {
    const checkout = path.join(path.sep, "tmp", "finny")
    expect(localDevelopmentDatabase(checkout)).toBe(localDevelopmentDatabase(path.join(checkout, ".")))
  })

  test("isolates separate worktrees", () => {
    const first = localDevelopmentDatabase(path.join(path.sep, "tmp", "finny"))
    const second = localDevelopmentDatabase(path.join(path.sep, "tmp", "finny-feature"))

    expect(first).not.toBe(second)
    expect(first).toMatch(/^opencode-local-[a-f0-9]{12}\.db$/)
    expect(second).toMatch(/^opencode-local-[a-f0-9]{12}\.db$/)
  })
})
