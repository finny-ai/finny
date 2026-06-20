import { describe, expect, test } from "bun:test"
import {
  algorithmNameFromWorkspaceSlug,
  inferBacktestWindow,
} from "../../src/agent/finny-workspace-context"

describe("finny workspace context helpers", () => {
  test("infers a three-month window from relative duration text", () => {
    const window = inferBacktestWindow(
      "Extract market data for AAPL 5min for a 3-month backtest window.",
      new Date("2026-06-16T15:00:00Z"),
    )
    expect(window.start).toBe("2026-03-18")
    expect(window.end).toBe("2026-06-16")
  })

  test("prefers explicit ISO dates over relative duration", () => {
    const window = inferBacktestWindow(
      "Use 2026-01-01 through 2026-03-01 for a 3-month backtest.",
      new Date("2026-06-16T15:00:00Z"),
    )
    expect(window.start).toBe("2026-01-01")
    expect(window.end).toBe("2026-03-01")
  })

  test("derives algorithm name from workspace slug prefix", () => {
    expect(algorithmNameFromWorkspaceSlug("aapl-5m-strategy.16.6.15.09.ce37659c")).toBe("aapl-5m-strategy")
  })
})
