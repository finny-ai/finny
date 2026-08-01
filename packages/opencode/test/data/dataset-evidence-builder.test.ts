import { describe, expect, test } from "bun:test"
import { buildDatasetEvidenceV2 } from "../../src/data/dataset-evidence-builder"
import { validateDatasetEvidenceV2 } from "../../src/data/dataset-evidence-v2"
import { buildDatasetQualificationAttestation } from "../../src/data/data-extractor-evidence"

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
  test("issues a hash-bound attestation only for runtime strict-qualified evidence", () => {
    const strict = buildDatasetQualificationAttestation({
      qualification: "strict_qualified",
      datasetHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
    })
    expect(strict).toEqual({
      schema: "finny.dataset_qualification_attestation",
      version: 1,
      datasetEvidenceId: `dataset-${"b".repeat(24)}`,
      datasetHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      qualification: "strict_qualified",
    })
    expect(
      buildDatasetQualificationAttestation({
        qualification: "research_only",
        datasetHash: "a".repeat(64),
        manifestHash: "b".repeat(64),
      }),
    ).toBeUndefined()
  })

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

  test("does not classify plausible heavy-tailed intraday returns as provider corruption", () => {
    const intradayRequest = {
      ...request,
      request_id: "request-btc-intraday-heavy-tail",
      requested_interval: "1m",
      requested_start: "2026-07-13",
      requested_end: "2026-07-13",
    }
    let price = 100
    const rows = Array.from({ length: 1440 }, (_, index) => {
      price *= index === 720 ? 1.01 : index % 2 === 0 ? 1.0001 : 0.9999
      const timestamp = new Date(Date.parse("2026-07-13T00:00:00Z") + index * 60_000).toISOString()
      return `${timestamp},${price},${price},${price},${price},1000`
    })
    const csvText = ["timestamp,open,high,low,close,volume", ...rows].join("\n")
    const built = buildDatasetEvidenceV2({
      csvBytes: Buffer.from(csvText),
      csvText,
      request: intradayRequest,
      workspaceSlug: "btc-intraday-heavy-tail.1.1.00.00",
      outputPath: "crypto/BTC_1m_2026-07-13_2026-07-13.csv",
      provider,
      priceBasis,
      now: new Date("2026-07-14T12:00:00Z"),
    })

    expect(built.manifest.quality.outlier_count).toBe(0)
    expect(built.manifest.qualification).toEqual({ status: "strict_qualified", reason_codes: [] })
  })

  test("still rejects a statistically extreme intraday move above the asset-class floor", () => {
    const intradayRequest = {
      ...request,
      request_id: "request-btc-intraday-corruption",
      requested_interval: "1m",
      requested_start: "2026-07-13",
      requested_end: "2026-07-13",
    }
    let price = 100
    const rows = Array.from({ length: 1440 }, (_, index) => {
      price *= index === 720 ? 1.1 : index % 2 === 0 ? 1.0001 : 0.9999
      const timestamp = new Date(Date.parse("2026-07-13T00:00:00Z") + index * 60_000).toISOString()
      return `${timestamp},${price},${price},${price},${price},1000`
    })
    const csvText = ["timestamp,open,high,low,close,volume", ...rows].join("\n")
    const built = buildDatasetEvidenceV2({
      csvBytes: Buffer.from(csvText),
      csvText,
      request: intradayRequest,
      workspaceSlug: "btc-intraday-corruption.1.1.00.00",
      outputPath: "crypto/BTC_1m_2026-07-13_2026-07-13.csv",
      provider,
      priceBasis,
      now: new Date("2026-07-14T12:00:00Z"),
    })

    expect(built.manifest.quality.outlier_count).toBe(1)
    expect(built.manifest.qualification).toEqual({ status: "research_only", reason_codes: ["OUTLIER"] })
  })

  test("ignores regular equity overnight returns while retaining strict continuous-bar checks", () => {
    const equityRequest = {
      ...request,
      request_id: "request-spy-session-gap",
      requested_algorithm_name: "spy-session-gap",
      requested_symbol: "SPY",
      requested_asset_class: "equity" as const,
      requested_interval: "1m",
      requested_start: "2026-07-13",
      requested_end: "2026-07-14",
    }
    let price = 100
    const rows: string[] = []
    for (const [session, start] of ["2026-07-13T13:30:00Z", "2026-07-14T13:30:00Z"].entries()) {
      if (session === 1) price *= 1.3
      for (let index = 0; index < 390; index += 1) {
        price *= index % 2 === 0 ? 1.0001 : 0.9999
        const timestamp = new Date(Date.parse(start) + index * 60_000).toISOString()
        rows.push(`${timestamp},${price},${price},${price},${price},1000`)
      }
    }
    const csvText = ["timestamp,open,high,low,close,volume", ...rows].join("\n")
    const built = buildDatasetEvidenceV2({
      csvBytes: Buffer.from(csvText),
      csvText,
      request: equityRequest,
      workspaceSlug: "spy-session-gap.1.1.00.00",
      outputPath: "stock/SPY_1m_2026-07-13_2026-07-14.csv",
      provider: { id: "alpaca", feed: "sip", venue: "CONSOLIDATED", providerSymbol: "SPY" },
      priceBasis: {
        ...priceBasis,
        basis: "adjusted",
        split_treatment: "split_adjusted",
        dividend_treatment: "unadjusted",
        corporate_action_status: "resolved",
      },
      now: new Date("2026-07-15T12:00:00Z"),
    })

    expect(built.manifest.quality.outlier_count).toBe(0)
    expect(built.manifest.qualification).toEqual({ status: "strict_qualified", reason_codes: [] })
  })

  test("keeps completed datasets above the 95% coverage threshold research-usable", () => {
    const dates = Array.from({ length: 20 }, (_, index) => `2026-06-${String(index + 1).padStart(2, "0")}`)
    const partialRequest = {
      ...request,
      request_id: "request-btc-high-coverage",
      requested_start: dates[0],
      requested_end: dates.at(-1)!,
    }
    const csvText = [
      "timestamp,open,high,low,close,volume",
      ...dates
        .slice(0, -1)
        .map((day, index) => `${day}T00:00:00Z,${100 + index},${101 + index},${99 + index},${100 + index},1000`),
    ].join("\n")
    const built = buildDatasetEvidenceV2({
      csvBytes: Buffer.from(csvText),
      csvText,
      request: partialRequest,
      workspaceSlug: "btc-daily-momentum.1.1.00.00",
      outputPath: "crypto/BTC_1d_2026-06-01_2026-06-20.csv",
      provider,
      priceBasis,
      now: new Date("2026-06-21T12:00:00Z"),
    })

    expect(built.manifest.timestamps).toMatchObject({ expected_count: 20, missing_count: 1 })
    expect(built.manifest.qualification).toEqual({
      status: "research_only",
      reason_codes: ["MISSING_EXPECTED_TIMESTAMP"],
    })
    expect(built.manifest.coverage).toBe("partial")
    expect(built.manifest.usable_for_parent).toBe("yes")
    expect(built.manifest.strict_backtest_eligible).toBe("no")
  })

  test("preserves structurally valid low-coverage bars for research", () => {
    const partialRequest = {
      ...request,
      request_id: "request-btc-low-coverage",
      requested_start: "2026-06-01",
      requested_end: "2026-06-10",
    }
    const csvText = [
      "timestamp,open,high,low,close,volume",
      "2026-06-01T00:00:00Z,100,101,99,100.5,1000",
      "2026-06-02T00:00:00Z,100.5,102,100,101.5,1200",
    ].join("\n")
    const built = buildDatasetEvidenceV2({
      csvBytes: Buffer.from(csvText),
      csvText,
      request: partialRequest,
      workspaceSlug: "btc-low-coverage.1.1.00.00",
      outputPath: "crypto/BTC_1d_2026-06-01_2026-06-10.csv",
      provider,
      priceBasis,
      now: new Date("2026-06-11T12:00:00Z"),
    })

    expect(built.manifest.timestamps).toMatchObject({ expected_count: 10, actual_count: 2, missing_count: 8 })
    expect(built.manifest.qualification.status).toBe("blocked")
    expect(built.manifest.usable_for_parent).toBe("no")
    expect(built.manifest.usable_for_research).toBe("yes")
    expect(built.manifest.strict_backtest_eligible).toBe("no")
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

  test("treats Alpaca daily local-midnight timestamps as their XNYS sessions", () => {
    const equityRequest = {
      ...request,
      request_id: "request-spy-daily",
      requested_algorithm_name: "spy-daily",
      requested_symbol: "SPY",
      requested_asset_class: "equity" as const,
      requested_interval: "1d",
      requested_start: "2026-07-13",
      requested_end: "2026-07-15",
    }
    const csvText = [
      "timestamp,open,high,low,close,volume",
      "2026-07-13T04:00:00Z,100,105,99,104,1000",
      "2026-07-14T04:00:00Z,104,108,103,107,1200",
      "2026-07-15T04:00:00Z,107,110,106,109,900",
    ].join("\n")
    const csvBytes = Buffer.from(csvText)
    const built = buildDatasetEvidenceV2({
      csvBytes,
      csvText,
      request: equityRequest,
      workspaceSlug: "spy-daily.1.1.00.00",
      outputPath: "stock/SPY_1d_2026-07-13_2026-07-15.csv",
      provider: { id: "alpaca", feed: "iex", venue: "NYSEARCA", providerSymbol: "SPY" },
      priceBasis,
      now: new Date("2026-07-16T12:00:00Z"),
    })

    expect(built.manifest.timestamps).toMatchObject({
      expected_count: 3,
      actual_count: 3,
      missing_count: 0,
      extra_count: 0,
    })
    expect(built.manifest.qualification).toEqual({ status: "strict_qualified", reason_codes: [] })
    expect(built.manifest.usable_for_parent).toBe("yes")
    expect(
      validateDatasetEvidenceV2({
        manifest: built.manifest,
        csvBytes,
        csvText,
        csvFacts: built.csvFacts,
      }),
    ).toEqual([])
  })

  test("rejects malformed rows instead of blessing a broken manifest", () => {
    const csvText = ["timestamp,open,high,low,close,volume", "2026-07-13T00:00:00Z,100,99,101,104,1000"].join("\n")
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
