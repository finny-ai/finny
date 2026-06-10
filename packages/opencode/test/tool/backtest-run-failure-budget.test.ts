import { describe, expect, test } from "bun:test"
import { countConsecutiveFailedBacktests, parseDataQualityFailure } from "../../src/tool/backtest-run"

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
