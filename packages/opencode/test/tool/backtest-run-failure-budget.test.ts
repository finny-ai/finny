import { describe, expect, test } from "bun:test"
import {
  inferSavedBacktestDates,
  formatCrucibleDataCollectionBlocker,
  paperApprovalRequestForWorkflow,
  parseDataQualityFailure,
  strictDataQualityNextSteps,
} from "../../src/tool/backtest"

describe("backtest paper approval challenge", () => {
  const hashes = {
    strategyHash: "strategy_hash",
    savedConfigHash: "config_hash",
    effectiveConfigHash: "effective_config_hash",
    dataHash: "data_hash",
    manifestHash: "manifest_hash",
    engineHash: "engine_hash",
    windowHash: "window_hash",
  }

  test("binds the controller challenge to the exact full-hash run identity", () => {
    const request = paperApprovalRequestForWorkflow({
      stage: "reviewable",
      backtest: {
        runId: "run_1",
        strategyHash: "strategy_hash",
        configHash: "config_hash",
        dataHash: "data_hash",
        engineHash: "engine_hash",
        hashes,
        identityHash: "identity_hash",
        verdict: "recommended_for_paper",
      },
    })
    expect(request).toMatchObject({
      kind: "paper_trading",
      scope: {
        runId: "run_1",
        hashes,
        identityHash: "identity_hash",
      },
    })
  })

  test("does not request paper approval for a non-recommended run", () => {
    expect(
      paperApprovalRequestForWorkflow({
        stage: "backtested",
        backtest: {
          runId: "run_1",
          strategyHash: "strategy_hash",
          configHash: "config_hash",
          dataHash: "data_hash",
          engineHash: "engine_hash",
          hashes,
          identityHash: "identity_hash",
          verdict: "candidate",
        },
      }),
    ).toBeUndefined()
  })
})

describe("backtest exact date windows", () => {
  test("infers saved explicit dates from common config fields", () => {
    expect(
      inferSavedBacktestDates(
        JSON.stringify({
          symbol: "ETH/USD",
          interval: "1h",
          backtest: { start: "2024-01-01", end: "2024-03-31" },
        }),
      ),
    ).toEqual({ startDate: "2024-01-01", endDate: "2024-03-31" })

    expect(
      inferSavedBacktestDates(
        JSON.stringify({
          evidence: { requested_start: "2024-01-01", requested_end: "2024-03-31" },
        }),
      ),
    ).toEqual({ startDate: "2024-01-01", endDate: "2024-03-31" })
  })

  test("ignores missing or non-ISO saved dates", () => {
    expect(inferSavedBacktestDates(JSON.stringify({ backtest: { start: "Jan 1 2024", end: "Mar 31 2024" } }))).toEqual(
      {},
    )
    expect(inferSavedBacktestDates(undefined)).toEqual({})
  })
})

describe("strict data quality next steps", () => {
  test("tells the agent not to call a blocked strict backtest ready", () => {
    const output = strictDataQualityNextSteps()
    expect(output).toContain("No performance metrics were produced")
    expect(output).toContain("do not call this strategy backtested, ready, or paper/live eligible")
    expect(output).toContain("Crucible could not obtain usable strict data")
    expect(output).toContain("Keep the confirmed symbol, interval, and date window unchanged")
    expect(output).not.toContain("repair_outliers")
  })
})

describe("Crucible data collection blockers", () => {
  test("reports the exact identity without suggesting request drift", () => {
    const output = formatCrucibleDataCollectionBlocker({
      symbol: "SPY",
      interval: "1h",
      duration: "1y",
      startDate: "2025-08-01",
      endDate: "2026-08-01",
      error: "primary and fallback providers returned no usable bars",
    })
    expect(output).toContain("SPY at 1h over 2025-08-01 -> 2026-08-01")
    expect(output).toContain("were not changed")
    expect(output).toContain("No performance metrics were produced")
    expect(output).not.toContain("shorter")
    expect(output).not.toContain("coarser")
  })

  test("includes the exact duration when dates are derived", () => {
    const output = formatCrucibleDataCollectionBlocker({
      symbol: "BTC.USD",
      interval: "15min",
      duration: "3m",
      error: "provider authentication failed",
    })
    expect(output).toContain("BTC.USD at 15min over duration-derived window (3m)")
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
