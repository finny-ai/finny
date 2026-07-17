import { describe, expect, test } from "bun:test"
import { buildDatasetEvidenceV2 } from "../../src/data/dataset-evidence-builder"
import { validateDatasetEvidenceV2 } from "../../src/data/dataset-evidence-v2"

const request = {
  request_id: "request-btc-daily",
  request_version: 2,
  request_content_hash: "sha256:request-content",
  requested_algorithm_name: "btc-daily-momentum",
  requested_symbol: "BTC",
  requested_asset_class: "crypto" as const,
  requested_interval: "1d",
  requested_start: "2026-07-13",
  requested_end: "2026-07-15",
}

const provider = {
  id: "binance",
  feed: "public-klines",
  venue: "BINANCE",
  providerSymbol: "BTCUSDT",
}

const priceBasis = {
  basis: "raw" as const,
  split_treatment: "not_applicable",
  dividend_treatment: "not_applicable",
  corporate_action_status: "not_applicable" as const,
  events: [],
}

describe("DatasetEvidenceV2 builder", () => {
  test("builds a validator-clean manifest and classifies today's open daily candle", () => {
    const csvText = [
      "timestamp,open,high,low,close,volume",
      "2026-07-13T00:00:00Z,100,105,99,104,1000",
      "2026-07-14T00:00:00Z,104,108,103,107,1200",
    ].join("\n")
    const csvBytes = Buffer.from(csvText)
    const built = buildDatasetEvidenceV2({
      csvBytes,
      csvText,
      request,
      workspaceSlug: "btc-daily-momentum.1.1.00.00",
      outputPath: "crypto/BTC_1d_2026-07-13_2026-07-15.csv",
      provider,
      priceBasis,
      now: new Date("2026-07-15T12:00:00Z"),
    })

    expect(built.manifest.version).toBe(2)
    expect(built.manifest.instrument.canonical_symbol).toBe("BTC")
    expect(built.manifest.timestamps).toMatchObject({ expected_count: 3, actual_count: 2, missing_count: 1 })
    expect(built.manifest.quality.incomplete_final_bar_count).toBe(1)
    expect(built.manifest.qualification).toEqual({
      status: "research_only",
      reason_codes: ["INCOMPLETE_FINAL_BAR"],
    })
    expect(built.manifest.coverage).toBe("partial_current_open_candle")
    expect(built.manifest.usable_for_parent).toBe("yes")
    expect(built.manifest.usable_for_research).toBe("yes")
    expect(built.manifest.strict_backtest_eligible).toBe("no")
    expect(
      validateDatasetEvidenceV2({
        manifest: built.manifest,
        csvBytes,
        csvText,
        csvFacts: built.csvFacts,
      }),
    ).toEqual([])
  })

  test("strict-qualifies complete clean evidence", () => {
    const csvText = [
      "timestamp,open,high,low,close,volume",
      "2026-07-13T00:00:00Z,100,105,99,104,1000",
      "2026-07-14T00:00:00Z,104,108,103,107,1200",
      "2026-07-15T00:00:00Z,107,110,106,109,900",
    ].join("\n")
    const csvBytes = Buffer.from(csvText)
    const built = buildDatasetEvidenceV2({
      csvBytes,
      csvText,
      request,
      workspaceSlug: "btc-daily-momentum.1.1.00.00",
      outputPath: "crypto/BTC_1d_2026-07-13_2026-07-15.csv",
      provider,
      priceBasis,
      now: new Date("2026-07-16T12:00:00Z"),
    })

    expect(built.manifest.qualification).toEqual({ status: "strict_qualified", reason_codes: [] })
    expect(built.manifest.coverage).toBe("full")
    expect(
      validateDatasetEvidenceV2({
        manifest: built.manifest,
        csvBytes,
        csvText,
        csvFacts: built.csvFacts,
      }),
    ).toEqual([])
  })

  test("keeps an entitlement-delayed current equity session research-usable", () => {
    const equityRequest = {
      ...request,
      request_id: "request-spy-intraday",
      requested_algorithm_name: "spy-intraday",
      requested_symbol: "SPY",
      requested_asset_class: "equity" as const,
      requested_interval: "5m",
      requested_start: "2026-07-16",
      requested_end: "2026-07-16",
    }
    const csvText = [
      "timestamp,open,high,low,close,volume",
      "2026-07-16T13:30:00Z,100,101,99,100.5,1000",
      "2026-07-16T13:35:00Z,100.5,101,100,100.75,1100",
      "2026-07-16T13:40:00Z,100.75,101,100.5,100.8,900",
    ].join("\n")
    const built = buildDatasetEvidenceV2({
      csvBytes: Buffer.from(csvText),
      csvText,
      request: equityRequest,
      workspaceSlug: "spy-intraday.1.1.00.00",
      outputPath: "stock/SPY_5m_2026-07-16_2026-07-16.csv",
      provider: { id: "alpaca", feed: "sip", venue: "CONSOLIDATED", providerSymbol: "SPY" },
      priceBasis,
      now: new Date("2026-07-16T10:01:00-04:00"),
    })

    expect(built.manifest.timestamps.missing_count).toBe(75)
    expect(built.manifest.qualification).toEqual({
      status: "research_only",
      reason_codes: ["INCOMPLETE_FINAL_BAR"],
    })
    expect(built.manifest.coverage).toBe("partial_current_open_candle")
    expect(built.manifest.usable_for_parent).toBe("yes")
  })

  test("rejects malformed rows instead of blessing a broken manifest", () => {
    const csvText = [
      "timestamp,open,high,low,close,volume",
      "2026-07-13T00:00:00Z,100,99,101,104,1000",
    ].join("\n")
    expect(() =>
      buildDatasetEvidenceV2({
        csvBytes: Buffer.from(csvText),
        csvText,
        request,
        workspaceSlug: "btc-daily-momentum.1.1.00.00",
        outputPath: "crypto/BTC_1d_2026-07-13_2026-07-15.csv",
        provider,
        priceBasis,
      }),
    ).toThrow("invalid OHLC")
  })
})
