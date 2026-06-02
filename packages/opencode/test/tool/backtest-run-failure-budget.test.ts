import { describe, expect, test } from "bun:test"
import { countConsecutiveFailedBacktests } from "../../src/tool/backtest-run"

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
