import { describe, expect, test } from "bun:test"
import { countConsecutiveFailedBacktests, parseDataQualityFailure, repairOutliersBlockMessage, strictDataQualityNextSteps } from "../../src/tool/backtest-run"

function backtestPart(algorithmName: string, output: string) {
  return {
    parts: [
      {
        type: "tool",
        tool: "finny_backtest_run",
        state: {
          status: "completed",
          input: { algorithmName },
          output,
          metadata: {},
        },
      },
    ],
  }
}

describe("backtest failure budget", () => {
  test("counts consecutive failed backtests for the same algorithm", () => {
    const messages = [
      backtestPart("btc-trend-follower", "Verdict: failed"),
      backtestPart("btc-trend-follower", "Verdict: failed"),
    ]

    expect(countConsecutiveFailedBacktests(messages, "btc-trend-follower")).toBe(2)
  })

  test("counts a single failed backtest as one, not two", () => {
    const messages = [backtestPart("spy-15m-mean-reversion", "Verdict: failed")]
    expect(countConsecutiveFailedBacktests(messages, "spy-15m-mean-reversion")).toBe(1)
  })

  test("does not count validation-only or non-backtest parts as failures", () => {
    const messages = [
      { parts: [{ type: "tool", tool: "finny_algorithm_validate", state: { status: "completed", input: { algorithmName: "spy-15m-mean-reversion" }, output: "Verdict: failed", metadata: {} } }] },
      backtestPart("spy-15m-mean-reversion", "Verdict: failed"),
    ]
    expect(countConsecutiveFailedBacktests(messages, "spy-15m-mean-reversion")).toBe(1)
  })

  test("resets after a non-failed backtest", () => {
    const messages = [
      backtestPart("btc-trend-follower", "Verdict: failed"),
      backtestPart("btc-trend-follower", "Verdict: weak_positive"),
      backtestPart("btc-trend-follower", "Verdict: failed"),
    ]

    expect(countConsecutiveFailedBacktests(messages, "btc-trend-follower")).toBe(1)
  })

  test("ignores other algorithms", () => {
    const messages = [
      backtestPart("btc-trend-follower", "Verdict: failed"),
      backtestPart("eth-trend-follower", "Verdict: failed"),
    ]

    expect(countConsecutiveFailedBacktests(messages, "btc-trend-follower")).toBe(1)
  })

  function scopedPart(algorithmName: string, symbol: string, interval: string, output: string) {
    return {
      parts: [
        {
          type: "tool",
          tool: "finny_backtest_run",
          state: {
            status: "completed",
            input: { algorithmName, interval },
            output,
            metadata: { results: { v2: { symbols: [symbol] } } },
          },
        },
      ],
    }
  }

  test("renaming the algorithm does not reset the budget for the same symbol+interval", () => {
    // The observed loophole: after 2 failures on spy-daily-trend, the agent
    // saved the same concept as spy-daily-golden-cross to bypass the block.
    const messages = [
      scopedPart("spy-daily-trend", "SPY", "1d", "Verdict: failed"),
      scopedPart("spy-daily-trend", "SPY", "1d", "Verdict: failed"),
    ]
    expect(
      countConsecutiveFailedBacktests(messages, "spy-daily-golden-cross", { symbol: "SPY", interval: "1d" }),
    ).toBe(2)
  })

  test("a different symbol does not share the budget", () => {
    const messages = [
      scopedPart("spy-daily-trend", "SPY", "1d", "Verdict: failed"),
      scopedPart("spy-daily-trend", "SPY", "1d", "Verdict: failed"),
    ]
    expect(
      countConsecutiveFailedBacktests(messages, "btc-daily-trend", { symbol: "BTC/USD", interval: "1d" }),
    ).toBe(0)
  })

  test("a different interval does not share the budget", () => {
    const messages = [
      scopedPart("spy-15m-mean-reversion", "SPY", "15min", "Verdict: failed"),
      scopedPart("spy-15m-mean-reversion", "SPY", "15min", "Verdict: failed"),
    ]
    expect(
      countConsecutiveFailedBacktests(messages, "spy-1h-trend", { symbol: "SPY", interval: "1h" }),
    ).toBe(0)
  })

  test("interval comparison is normalized (15min vs 15m)", () => {
    const messages = [
      scopedPart("a", "SPY", "15min", "Verdict: failed"),
      scopedPart("b", "SPY", "15m", "Verdict: failed"),
    ]
    expect(countConsecutiveFailedBacktests(messages, "c", { symbol: "SPY", interval: "15min" })).toBe(2)
  })
})

describe("backtest repair approval", () => {
  test("blocks repair_outliers unless explicitly approved", () => {
    expect(
      repairOutliersBlockMessage({
        dataQualityMode: "repair_outliers",
      }),
    ).toContain("requires explicit user approval")
  })

  test("does not treat failure-budget approval as repair approval", () => {
    expect(
      repairOutliersBlockMessage({
        dataQualityMode: "repair_outliers",
        userApproved: true,
      } as any),
    ).toContain("requires explicit user approval")
  })

  test("allows strict mode and explicitly approved repaired-data research reruns", () => {
    expect(repairOutliersBlockMessage({ dataQualityMode: "strict" })).toBeUndefined()
    expect(
      repairOutliersBlockMessage({
        dataQualityMode: "repair_outliers",
        repairOutliersApproved: true,
      }),
    ).toBeUndefined()
  })
})

describe("strict data quality next steps", () => {
  test("tells the agent not to call a blocked strict backtest ready", () => {
    const output = strictDataQualityNextSteps()
    expect(output).toContain("No performance metrics were produced")
    expect(output).toContain("do not call this strategy backtested, ready, or paper/live eligible")
    expect(output).toContain("Verify the flagged candles first")
    expect(output).toContain("Only after explicit user approval")
    expect(output.indexOf("Verify the flagged candles first")).toBeLessThan(output.indexOf("Only after explicit user approval"))
    expect(output).toContain("before changing the backtest window, interval, provider, or data-quality strictness")
  })
})

describe("backtest data quality failure parsing", () => {
  test("parses strict outlier failures into structured metadata", () => {
    const error = [
      "Strict engine failed: __FINNY_OUTLIER__: ts=2026-03-09 19:15:00+00:00 prev_close=670.4 close=677.38 log_return=0.010357866126851967 z=8.26 provider=alpaca",
      "Data quality failed before resample: 1 severe outlier bar(s) (provider=alpaca, symbol=SPY, interval=15min, raw_rows=2054, coverage=100.00%, gaps=0, duplicates=0, invalid_ohlc=0, outliers=1, zero_volume=0)",
      "outlier ts=2026-03-09 19:15:00+00:00 prev_close=670.4 close=677.38 log_return=0.0103579 z=8.26 provider=alpaca",
    ].join("\n")

    const parsed = parseDataQualityFailure(error, {
      algorithmName: "spy-15m-mean-reversion-clean",
      duration: "3m",
      interval: "15min",
      capital: "10000",
      dataQualityMode: "strict",
    })

    expect(parsed).toMatchObject({
      kind: "data_quality_failed",
      algorithmName: "spy-15m-mean-reversion-clean",
      phase: "before_resample",
      symbol: "SPY",
      provider: "alpaca",
      interval: "15min",
      rawRows: 2054,
      coverage: 100,
      gaps: 0,
      duplicates: 0,
      invalidOhlc: 0,
      outliers: 1,
      zeroVolume: 0,
      repair_outliers_allowed: false,
    })
    expect(parsed?.outlierDetails[0]).toEqual({
      timestamp: "2026-03-09 19:15:00+00:00",
      prev_close: 670.4,
      close: 677.38,
      log_return: 0.010357866126851967,
      z_score: 8.26,
      provider: "alpaca",
    })
  })
})
