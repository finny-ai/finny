import { describe, expect, test } from "bun:test"
import { formatWalkForwardLines } from "../../src/tool/backtest-walkforward"

describe("backtest walk-forward formatting", () => {
  test("renders nullable robustness probabilities as N/A", () => {
    const lines = formatWalkForwardLines({
      algorithmName: "qqq-cross",
      version: 3,
      duration: "1y",
      start: "2025-06-02",
      end: "2026-06-02",
      verdict: "degraded",
      verdictReason: "probability metrics unavailable",
      walkForward: {
        n_folds: 2,
        is_sharpe_mean: 1.2,
        oos_sharpe_mean: 0.4,
        oos_decay: 0.33,
        flag_threshold: 0.7,
        flagged: false,
        deflated_sharpe: null,
        probabilistic_sharpe: null,
        folds: [
          {
            fold: 1,
            train_start: "2025-06-02T00:00:00Z",
            train_end: "2025-12-02T00:00:00Z",
            test_start: "2025-12-03T00:00:00Z",
            test_end: "2026-06-02T00:00:00Z",
            is_sharpe: null,
            oos_sharpe: null,
            is_return: 0.02,
            oos_return: 0.01,
          },
        ],
      },
    })

    const output = lines.join("\n")
    expect(output).toContain("Deflated Sharpe prob:  N/A")
    expect(output).toContain("Prob. Sharpe ratio:    N/A")
    expect(output).toContain("N/A\tN/A\t1.00%")
  })
})
