import { describe, expect, test } from "bun:test"
import { evaluateFinnyWorkspacePathPolicy, isProtectedFinnyController } from "../../src/tool/finny-workspace-guard"

describe("protected Fund Manager workspace policy", () => {
  test("recognizes strategy and fund controllers without treating specialists as controllers", () => {
    expect(isProtectedFinnyController("finny")).toBe(true)
    expect(isProtectedFinnyController("fund_manager")).toBe(true)
    expect(isProtectedFinnyController("fund_risk_analyst")).toBe(false)
    expect(isProtectedFinnyController("general")).toBe(false)
  })

  test("blocks Fund Manager writes even when no strategy workspace is bound", async () => {
    const base = {
      agent: "fund_manager",
      sessionID: "ses-fund",
      filePath: "/tmp/strategy.py",
      directory: "/tmp",
      worktree: "/tmp",
    }
    await expect(evaluateFinnyWorkspacePathPolicy({ ...base, operation: "write" })).resolves.toEqual(
      expect.objectContaining({
        allowed: false,
        code: "fund_manager_file_write_blocked",
      }),
    )
    await expect(evaluateFinnyWorkspacePathPolicy({ ...base, operation: "edit" })).resolves.toEqual(
      expect.objectContaining({
        allowed: false,
        code: "fund_manager_file_write_blocked",
      }),
    )
    await expect(evaluateFinnyWorkspacePathPolicy({ ...base, operation: "read" })).resolves.toEqual({
      allowed: true,
    })
  })
})
