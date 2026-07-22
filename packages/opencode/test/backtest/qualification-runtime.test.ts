import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compileInputFromActiveEvidence } from "../../src/backtest/qualification-runtime"
import { DEFAULT_QUALIFICATION_POLICY_V1 } from "../../src/backtest/qualification-policy"

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
})

async function dataset(timestamps: string[], identity: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-plan-runtime-"))
  cleanups.push(dir)
  const csvPath = path.join(dir, "bars.csv")
  await fs.writeFile(csvPath, [
    "timestamp,open,high,low,close,volume",
    ...timestamps.map((timestamp) => `${timestamp},1,2,0.5,1.5,10`),
  ].join("\n"))
  return {
    csvPath,
    csvSha256: "a".repeat(64),
    manifestPath: path.join(dir, "bars.manifest.json"),
    manifestSha256: "b".repeat(64),
    identity: {
      schemaVersion: 1,
      source: "test",
      runId: "runtime-evidence",
      requestedAlgorithmName: "candidate",
      requestedSymbol: identity.symbol,
      actualSymbol: identity.symbol,
      requestedInterval: identity.interval,
      actualInterval: identity.interval,
      requestedAssetClass: identity.assetClass,
      actualAssetClass: identity.assetClass,
      requestedStart: timestamps[0],
      requestedEnd: timestamps.at(-1)!,
      actualStart: timestamps[0],
      actualEnd: timestamps.at(-1)!,
    },
  } as any
}

function request(timestamps: string[], interval: string) {
  return {
    schema_version: 1 as const,
    request_id: "runtime-request",
    request_version: 1,
    content_hash: "request-hash",
    requested_interval: interval,
    requested_start: timestamps[0],
    requested_end: timestamps.at(-1),
    execution_assumptions: {},
    evidence_requirements: { data_extractor: true, news_agent: false, fail_closed_on_identity_mismatch: true },
    user_approvals: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }
}

describe("active evidence qualification adapter", () => {
  test("derives policy, warmup, search budget, DST sessions, and timestamps without model dates", async () => {
    const timestamps = [
      ...Array.from({ length: 10 }, (_, index) => new Date(Date.parse("2025-03-07T14:30:00Z") + index * 300_000).toISOString()),
      ...Array.from({ length: 10 }, (_, index) => new Date(Date.parse("2025-03-10T13:30:00Z") + index * 300_000).toISOString()),
    ]
    const input = await compileInputFromActiveEvidence({
      request: request(timestamps, "5min"),
      dataset: await dataset(timestamps, { symbol: "SPY", interval: "5min", assetClass: "equity" }),
      candidate: { algorithmId: "candidate-runtime", code: "pass", config: JSON.stringify({ warmup_bars: 2, optimization_budget: 7 }) } as any,
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
    })
    expect(input.warmupBars).toBe(2)
    expect(input.declaredSearchBudget).toBe(7)
    expect(input.candidate).toMatchObject({
      candidateId: "candidate-runtime",
      warmupBars: 2,
      declaredSearchBudget: 7,
    })
    expect(input.candidate.codeHash).toHaveLength(64)
    expect(input.candidate.configHash).toHaveLength(64)
    expect(input.qualificationPolicy).toBe(DEFAULT_QUALIFICATION_POLICY_V1)
    expect(input.datasetEvidence.calendar).toMatchObject({ calendarId: "US_EQUITIES", timezone: "America/New_York" })
    expect(new Set(input.datasetEvidence.orderedBars.map((bar) => bar.sessionId))).toEqual(new Set(["2025-03-07", "2025-03-10"]))
    expect(input.datasetEvidence.qualification).toBe("research_only")
  })

  test("assigns overnight futures bars to the next trading session", async () => {
    const timestamps = Array.from({ length: 20 }, (_, index) => new Date(Date.parse("2025-03-09T22:00:00Z") + index * 3_600_000).toISOString())
    const input = await compileInputFromActiveEvidence({
      request: request(timestamps, "1h"),
      dataset: await dataset(timestamps, { symbol: "ES=F", interval: "1h", assetClass: "future" }),
      candidate: { algorithmId: "candidate-future", code: "pass", config: JSON.stringify({ symbol: "ES=F", asset_class: "future" }) } as any,
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
    })
    expect(input.datasetEvidence.calendar).toMatchObject({ calendarId: "US_FUTURES", timezone: "America/Chicago" })
    expect(input.datasetEvidence.orderedBars[0].sessionId).toBe("2025-03-10")
  })

  test("accepts only an exact runtime-issued qualification attestation", async () => {
    const timestamps = Array.from({ length: 20 }, (_, index) => new Date(Date.parse("2025-01-02T14:30:00Z") + index * 300_000).toISOString())
    const evidence = await dataset(timestamps, { symbol: "SPY", interval: "5min", assetClass: "equity" })
    evidence.qualificationAttestation = {
      schema: "finny.dataset_qualification_attestation",
      version: 1,
      datasetEvidenceId: "strict-evidence-v1",
      datasetHash: evidence.csvSha256,
      manifestHash: evidence.manifestSha256,
      qualification: "strict_qualified",
    }
    const input = await compileInputFromActiveEvidence({
      request: request(timestamps, "5min"),
      dataset: evidence,
      candidate: { algorithmId: "candidate-strict", code: "pass", config: "{}" } as any,
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
    })
    expect(input.datasetEvidence).toMatchObject({
      datasetEvidenceId: "strict-evidence-v1",
      qualification: "strict_qualified",
    })
    evidence.qualificationAttestation.datasetHash = "c".repeat(64)
    const tampered = await compileInputFromActiveEvidence({
      request: request(timestamps, "5min"),
      dataset: evidence,
      candidate: { algorithmId: "candidate-strict", code: "pass", config: "{}" } as any,
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
    })
    expect(tampered.datasetEvidence.qualification).toBe("research_only")
  })
})
