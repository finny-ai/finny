import { describe, expect, test } from "bun:test"
import { buildDashboardSnapshot } from "../../../../convex/nativeHedgeLive"

describe("native hedge dashboard snapshot", () => {
  test("exposes run presentation fields without ledger internals", () => {
    const result = buildDashboardSnapshot({
      now: 30,
      runningCount: 1,
      runningCountCapped: false,
      runs: [
        {
          algorithmName: " Momentum ",
          symbol: "SPY",
          interval: "1h",
          brokerage: "alpaca",
          mode: "paper",
          status: "running",
          startedAt: 10,
          lastEventAt: 20,
          error: "private failure detail",
        },
      ],
    })

    expect(result).toEqual({
      generatedAt: 30,
      runningCount: 1,
      runningCountCapped: false,
      recentRuns: [
        {
          algorithmName: "Momentum",
          symbol: "SPY",
          interval: "1h",
          brokerage: "alpaca",
          mode: "paper",
          status: "running",
          startedAt: 10,
          stoppedAt: undefined,
          lastEventAt: 20,
          hasError: true,
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain("private failure detail")
  })

  test("preserves capped active-run counts", () => {
    expect(buildDashboardSnapshot({ now: 1, runningCount: 100, runningCountCapped: true, runs: [] })).toMatchObject({
      runningCount: 100,
      runningCountCapped: true,
    })
  })

  test("bounds presentation strings and collapses unknown statuses", () => {
    const longName = `algo-${"x".repeat(200)}`
    const result = buildDashboardSnapshot({
      now: 2,
      runningCount: 0,
      runningCountCapped: false,
      runs: [
        {
          algorithmName: longName,
          symbol: "SPY",
          status: "weird-custom-ledger-status",
          lastEventAt: 1,
          error: "secret stack trace",
        },
      ],
    })
    expect(result.recentRuns[0]!.algorithmName!.length).toBeLessThanOrEqual(80)
    expect(result.recentRuns[0]!.status).toBe("unknown")
    expect(result.recentRuns[0]!.hasError).toBe(true)
    expect(JSON.stringify(result)).not.toContain("secret stack trace")
    expect(JSON.stringify(result)).not.toContain(longName)
  })
})
