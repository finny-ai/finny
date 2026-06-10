import { expect, test } from "bun:test"
import { formatFinnyDataQualityBlocker } from "../../../src/cli/cmd/tui/component/finny-data-quality-blocker"

test("formats Finny strict data quality blocker details", () => {
  const output = formatFinnyDataQualityBlocker({
    kind: "data_quality_failed",
    algorithmName: "spy-15m-mean-reversion-clean",
    params: { duration: "3m", interval: "15min", capital: "10000", dataQualityMode: "strict" },
    phase: "before_resample",
    reason:
      "Data quality failed before resample: 1 severe outlier bar(s) (provider=alpaca, symbol=SPY, interval=15min)",
    symbol: "SPY",
    provider: "alpaca",
    interval: "15min",
    rawRows: 2054,
    repair_outliers_allowed: false,
    outlierDetails: [
      {
        timestamp: "2026-03-09 19:15:00+00:00",
        prev_close: 670.4,
        close: 677.38,
        log_return: 0.010357866126851967,
        z_score: 8.26,
        provider: "alpaca",
      },
    ],
  })

  expect(output).toContain("Strict data quality blocked this backtest.")
  expect(output).toContain("Algorithm: spy-15m-mean-reversion-clean")
  expect(output).toContain("Phase: before_resample")
  expect(output).toContain("symbol=SPY")
  expect(output).toContain("provider=alpaca")
  expect(output).toContain("ts=2026-03-09 19:15:00+00:00")
  expect(output).toContain("Stopped without running repair_outliers.")
  expect(output).toContain("No performance metrics were produced")
  expect(output).toContain("Verify the flagged candles first")
  expect(output).toContain("Only after explicit user approval")
  expect(output.indexOf("Verify the flagged candles first")).toBeLessThan(output.indexOf("Only after explicit user approval"))
})
