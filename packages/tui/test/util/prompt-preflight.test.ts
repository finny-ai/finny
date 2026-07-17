import { describe, expect, test } from "bun:test"
import { promptNeedsWorkspacePreflight } from "../../src/util/prompt-preflight"

describe("promptNeedsWorkspacePreflight", () => {
  test("requires build/research agent", () => {
    expect(promptNeedsWorkspacePreflight("AAPL 5min", "chat")).toBe(false)
    expect(promptNeedsWorkspacePreflight("options algo", "build")).toBe(true)
    expect(promptNeedsWorkspacePreflight("options algo", "research")).toBe(true)
  })

  test("does not depend on ticker presence", () => {
    expect(promptNeedsWorkspacePreflight("what is sharpe ratio?", "build")).toBe(true)
    expect(promptNeedsWorkspacePreflight("options algo", "build")).toBe(true)
  })

  test("does not imply optimistic TUI setup seeding by itself", () => {
    expect(promptNeedsWorkspacePreflight("options algo", "build")).toBe(true)
  })
})
