import { describe, expect, test } from "bun:test"
import { appendPreflightStep } from "../../../src/routes/session/preflight-steps"

describe("appendPreflightStep", () => {
  test("appends new steps and marks previous active step done", () => {
    const next = appendPreflightStep([{ message: "Preparing workspace…", status: "active" }], "Created workspace aapl", false)
    expect(next).toEqual([
      { message: "Preparing workspace…", status: "done" },
      { message: "Created workspace aapl", status: "active" },
    ])
  })

  test("marks duplicate ready message done", () => {
    const next = appendPreflightStep(
      [{ message: "Environment ready", status: "active" }],
      "Environment ready",
      true,
    )
    expect(next).toEqual([{ message: "Environment ready", status: "done" }])
  })
})
