import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { expectedEvidenceTimestamps } from "../../src/data/dataset-evidence-calendar"
import {
  DATASET_EVIDENCE_SCHEMA,
  evidenceQualification,
  normalizedCsvSemanticHash,
  validateDatasetEvidenceV2,
  type DatasetEvidenceV2,
} from "../../src/data/dataset-evidence-v2"

const csv = [
  "timestamp,open,high,low,close,volume",
  "2024-01-02T14:30:00Z,100,101,99,100.5,1000",
  "2024-01-02T14:35:00Z,100.5,102,100,101,1100",
].join("\n")
const bytes = Buffer.from(csv)
const sha256 = (value: Uint8Array | string) => crypto.createHash("sha256").update(value).digest("hex")

function evidence(overrides: Partial<DatasetEvidenceV2> = {}): DatasetEvidenceV2 {
  return {
    schema: DATASET_EVIDENCE_SCHEMA,
    version: 2,
    evidence_id: "dsv2_test_20240102_spy",
    provider: { id: "alpaca", feed: "sip", venue: "NYSE" },
    instrument: { asset_class: "equity", canonical_symbol: "SPY", provider_symbol: "SPY" },
    interval: "5m",
    calendar: {
      id: "XNYS",
      version: "finny-calendars-2026.1",
      timezone: "America/New_York",
      session_type: "regular",
      half_day_policy: "scheduled_early_close",
    },
    window: {
      requested_start_inclusive: "2024-01-02T14:30:00Z",
      requested_end_inclusive: "2024-01-02T14:35:00Z",
      actual_start_inclusive: "2024-01-02T14:30:00Z",
      actual_end_inclusive: "2024-01-02T14:35:00Z",
    },
    timestamps: { expected_count: 2, actual_count: 2, missing_count: 0, extra_count: 0, missing_ranges: [] },
    quality: {
      duplicate_count: 0,
      ohlc_violation_count: 0,
      outlier_count: 0,
      zero_volume_count: 0,
      invalid_volume_count: 0,
      incomplete_final_bar_count: 0,
    },
    price_basis: {
      basis: "adjusted",
      split_treatment: "back_adjusted",
      dividend_treatment: "total_return_not_in_price",
      corporate_action_status: "resolved",
      events: [],
    },
    hashes: {
      raw_bytes_sha256: sha256(bytes),
      normalized_semantic_sha256: normalizedCsvSemanticHash(csv),
      processed_bytes_sha256: sha256(bytes),
      transformation_versions: { normalization: "finny-ohlcv-1" },
    },
    repair_lineage: null,
    qualification: { status: "strict_qualified", reason_codes: [] },
    ...overrides,
  }
}

const facts = { rows: 2, uniqueTimestamps: 2, duplicates: 0, invalidRows: 0, invalidOhlc: 0 }

describe("DatasetEvidenceV2", () => {
  test("calendar reconciliation covers XNYS half-days and prior-day CMES opens", () => {
    const halfDay = expectedEvidenceTimestamps({
      calendarId: "XNYS",
      sessionType: "regular",
      interval: "5m",
      requestedStartInclusive: "2024-07-03",
      requestedEndInclusive: "2024-07-03",
    })
    const mondayFuture = expectedEvidenceTimestamps({
      calendarId: "CMES",
      sessionType: "overnight",
      interval: "1h",
      requestedStartInclusive: "2024-03-11",
      requestedEndInclusive: "2024-03-11",
    })
    expect(halfDay).toHaveLength(42)
    expect(new Date(halfDay[0]).toISOString()).toBe("2024-07-03T13:30:00.000Z")
    expect(mondayFuture).toHaveLength(23)
    expect(new Date(mondayFuture[0]).toISOString()).toBe("2024-03-10T22:00:00.000Z")
  })

  test("accepts a complete hash-verifiable strict manifest", () => {
    expect(validateDatasetEvidenceV2({ manifest: evidence(), csvBytes: bytes, csvText: csv, csvFacts: facts })).toEqual(
      [],
    )
  })

  test("detects byte and normalized-semantic tampering", () => {
    const tampered = Buffer.from(csv.replace("101,1100", "101,1200"))
    const issues = validateDatasetEvidenceV2({
      manifest: evidence(),
      csvBytes: tampered,
      csvText: tampered.toString("utf8"),
      csvFacts: facts,
    })
    expect(issues).toContain("raw bytes hash does not match CSV")
    expect(issues).toContain("processed bytes hash does not match CSV")
    expect(issues).toContain("normalized semantic hash does not match CSV")
  })

  test("unknown price basis and unresolved actions cannot be strict", () => {
    const manifest = evidence({
      price_basis: {
        basis: "unknown",
        split_treatment: "unknown",
        dividend_treatment: "unknown",
        corporate_action_status: "unresolved",
        events: [],
      },
    })
    const issues = validateDatasetEvidenceV2({ manifest, csvBytes: bytes, csvText: csv, csvFacts: facts })
    expect(issues).toContain("strict_qualified evidence has unknown price basis")
    expect(issues).toContain("strict_qualified evidence has unresolved corporate actions")
  })

  test("a no-op repair remains permanently non-promotable", () => {
    const manifest = evidence({
      repair_lineage: {
        parent_evidence_id: "dsv2_parent",
        transformations: [{ name: "drop_outliers", version: "1", affected_rows: 0 }],
        actor: "data_quality_runtime",
        approval: "automatic_research_only",
      },
    })
    expect(validateDatasetEvidenceV2({ manifest, csvBytes: bytes, csvText: csv, csvFacts: facts })).toContain(
      "repaired evidence is permanently non-promotable",
    )
  })

  test("V1 remains classifiable but is research-only legacy", () => {
    expect(evidenceQualification({ schema_version: 1 } as any)).toBe("research_only_legacy")
    expect(evidenceQualification(evidence())).toBe("strict_qualified")
  })

  test("missing range totals and timestamp arithmetic are enforced", () => {
    const manifest = evidence({
      timestamps: {
        expected_count: 3,
        actual_count: 2,
        missing_count: 1,
        extra_count: 0,
        missing_ranges: [{ start: "2024-01-02T14:40:00Z", end: "2024-01-02T14:40:00Z", count: 2 }],
      },
      qualification: { status: "blocked", reason_codes: ["MISSING_EXPECTED_TIMESTAMP"] },
    })
    expect(validateDatasetEvidenceV2({ manifest, csvBytes: bytes, csvText: csv, csvFacts: facts })).toContain(
      "missing range counts do not equal missing_count",
    )
  })

  test("recomputes the calendar set instead of trusting strict manifest counts", () => {
    const gappedCsv = [
      "timestamp,open,high,low,close,volume",
      "2024-01-02T14:30:00Z,100,101,99,100.5,1000",
      "2024-01-02T14:40:00Z,100.5,102,100,101,1100",
    ].join("\n")
    const gappedBytes = Buffer.from(gappedCsv)
    const manifest = evidence({
      window: {
        requested_start_inclusive: "2024-01-02T14:30:00Z",
        requested_end_inclusive: "2024-01-02T14:40:00Z",
        actual_start_inclusive: "2024-01-02T14:30:00Z",
        actual_end_inclusive: "2024-01-02T14:40:00Z",
      },
      hashes: {
        raw_bytes_sha256: sha256(gappedBytes),
        normalized_semantic_sha256: normalizedCsvSemanticHash(gappedCsv),
        processed_bytes_sha256: sha256(gappedBytes),
        transformation_versions: { normalization: "finny-ohlcv-1" },
      },
    })
    const issues = validateDatasetEvidenceV2({
      manifest,
      csvBytes: gappedBytes,
      csvText: gappedCsv,
      csvFacts: facts,
    })
    expect(issues).toContain("timestamps.expected_count=2 but calendar expects 3")
    expect(issues).toContain("timestamps.missing_count=0 but calendar reconciliation found 1")
  })

  test("malformed strict nested objects return typed blockers instead of throwing", () => {
    const manifest = {
      ...evidence(),
      timestamps: undefined,
      quality: undefined,
      price_basis: undefined,
      qualification: { status: "strict_qualified" },
    }
    expect(() => validateDatasetEvidenceV2({ manifest, csvBytes: bytes, csvText: csv, csvFacts: facts })).not.toThrow()
    const issues = validateDatasetEvidenceV2({ manifest, csvBytes: bytes, csvText: csv, csvFacts: facts })
    expect(issues).toContain("timestamps is required")
    expect(issues).toContain("quality is required")
    expect(issues).toContain("price_basis is required")
    expect(issues).toContain("qualification.reason_codes must be an array")
  })

  test("provider feed identity cannot disagree with legacy acquisition identity", () => {
    const manifest = {
      ...evidence(),
      source: "yfinance",
      actual_symbol: "SPY",
      actual_interval: "5m",
      actual_asset_class: "equity",
      actual_start: "2024-01-02T14:30:00Z",
      actual_end: "2024-01-02T14:35:00Z",
      rows: 2,
    }
    expect(validateDatasetEvidenceV2({ manifest, csvBytes: bytes, csvText: csv, csvFacts: facts })).toContain(
      "legacy mirror mismatch: source/provider.id",
    )
  })

  test("resolved split and dividend treatment is explicit and strict-eligible", () => {
    const manifest = evidence({
      price_basis: {
        basis: "adjusted",
        split_treatment: "back_adjusted",
        dividend_treatment: "not_in_price",
        corporate_action_status: "resolved",
        events: [
          { type: "split", effective_at: "2024-01-02T00:00:00Z", value: 2, treatment: "back_adjusted" },
          { type: "dividend", effective_at: "2024-01-02T00:00:00Z", value: 0.25, treatment: "not_in_price" },
        ],
      },
    })
    expect(validateDatasetEvidenceV2({ manifest, csvBytes: bytes, csvText: csv, csvFacts: facts })).toEqual([])
  })

  test("normalized semantics reconcile equivalent bounded provider outputs", () => {
    const alternate = [
      "volume,close,low,high,open,timestamp",
      "1000.0,100.50,99.0,101.0,100.0,2024-01-02T09:30:00-05:00",
      "1100.0,101.0,100.0,102.0,100.50,2024-01-02T09:35:00-05:00",
    ].join("\r\n")
    expect(normalizedCsvSemanticHash(alternate)).toBe(normalizedCsvSemanticHash(csv))
  })
})
