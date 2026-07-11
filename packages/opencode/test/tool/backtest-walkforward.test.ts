import { describe, expect, test } from "bun:test"
import { formatWalkForwardLines } from "../../src/tool/backtest"

describe("backtest walk-forward formatting", () => {
  test("renders nullable robustness probabilities as N/A", () => {
    const walkForward = {
      n_folds: 2,
      is_sharpe_mean: 1.2,
      oos_sharpe_mean: 0.4,
      oos_decay: 0.33,
      is_to_oos_sharpe_change: -0.8,
      flag_threshold: 0.7,
      flagged: false,
      deflated_sharpe: null,
      probabilistic_sharpe: null,
      stitched_oos_return: 0.01,
      stitched_oos_sharpe: 0.4,
      stitched_oos_trades: 3,
      stitched_oos_bars: 50,
      stitched_oos_coverage: 1,
      ruined_folds: 0,
      multiple_testing_trials: 1,
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
          oos_trades: 3,
          oos_coverage: 1,
          ruined: false,
        },
      ],
    }
    const lines = formatWalkForwardLines({
      algorithmName: "qqq-cross",
      version: 3,
      duration: "1y",
      start: "2025-06-02",
      end: "2026-06-02",
      verdict: "degraded",
      verdictReason: "probability metrics unavailable",
      walkForward,
    })

    const output = lines.join("\n")
    expect(output).toContain("Deflated Sharpe prob:  N/A")
    expect(output).toContain("Prob. Sharpe ratio:    N/A")
    expect(output).toContain("IS->OOS Sharpe change: -0.80")
    expect(output).toContain("Robustness ratio:      0.33")
    expect(output).not.toContain("OOS decay ratio")
    expect(output).toContain("Multiple-test trials:  1")
    expect(output).toContain("N/A\tN/A\t1.00%\t3\t100.00%\tno")

    const guardedOutput = formatWalkForwardLines({
      algorithmName: "qqq-cross",
      version: 3,
      duration: "1y",
      start: "2025-06-02",
      end: "2026-06-02",
      verdict: "degraded",
      verdictReason: "probability metrics unavailable",
      walkForward: { ...walkForward, is_sharpe_mean: 0, oos_decay: null },
    }).join("\n")
    expect(guardedOutput).toContain("Robustness ratio:      N/A")
  })
})
