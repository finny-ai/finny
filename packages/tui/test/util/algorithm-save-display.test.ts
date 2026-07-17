import { describe, expect, test } from "bun:test"
import { algorithmSaveFailureDisplay } from "../../src/util/algorithm-save-display"

describe("algorithm save failure display", () => {
  test("shows the name and failure without echoing large save inputs", () => {
    const view = algorithmSaveFailureDisplay(
      { name: "spy-mean-reversion", code: "very large strategy", mission: "very large mission" },
      "Failed to save strategy because validation found 1 blocking issue:\nFix: cap position size.",
    )
    expect(view.title).toBe('Failed to save "spy-mean-reversion"')
    expect(view.output).toContain("Fix: cap position size")
    expect(JSON.stringify(view)).not.toContain("very large strategy")
    expect(JSON.stringify(view)).not.toContain("very large mission")
  })
})
