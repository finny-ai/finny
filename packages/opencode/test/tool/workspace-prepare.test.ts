import { describe, expect, test } from "bun:test"
import { promptFromParams } from "../../src/tool/workspace-prepare"

describe("workspace prepare request context", () => {
  test("puts structured dates before summary dates", () => {
    const prompt = promptFromParams(
      {
        requestSummary: "Earlier context mentions 2023-01-01 and 2023-06-01.",
        startDate: "2024-07-10",
        endDate: "2026-07-10",
      },
      "",
    )
    expect(prompt.startsWith("date window 2024-07-10 to 2026-07-10")).toBe(true)
  })
})
