import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import crypto from "crypto"
import { BacktestRunner } from "../../src/backtest/runner"
import type { Algorithm } from "../../src/algorithm"
import { validateExistingDataExtractorEvidence, type VerifiedDatasetRef } from "../../src/data/data-extractor-evidence"
import { normalizedCsvSemanticHash } from "../../src/data/dataset-evidence-v2"
import { qualificationInputForResearch } from "../../src/backtest/qualification-policy"
import { FINNY_BROKER_PY } from "../../src/backtest/broker-py"

function algo(overrides: Partial<Algorithm.Info> = {}): Algorithm.Info {
  return {
    algorithmId: "algo_test",
    userId: "user",
    name: "test",
    code: "class Strategy:\n    def __init__(self, broker, params=None): self.broker = broker\n    def on_bar(self, symbol, bar): pass\n",
    language: "python",
    version: 1,
    status: "draft",
    config: JSON.stringify({ symbol: "AAPL", risk: { starting_equity_usd: 10000 } }),
    time_created: 0,
    time_updated: 0,
    ...overrides,
  }
}

async function verifiedDataset(root: string): Promise<VerifiedDatasetRef> {
  const csvPath = path.join(root, "SPY_5m.csv")
  const manifestPath = path.join(root, "SPY_5m.manifest.json")
  const csv = Buffer.from(
    [
      "timestamp,open,high,low,close,volume",
      "2026-01-09T14:30:00Z,590,591,589,590.5,100000",
      "2026-01-09T14:35:00Z,590.5,592,590,591.5,110000",
    ].join("\n"),
  )
  const csvText = csv.toString("utf8")
  const csvHash = crypto.createHash("sha256").update(csv).digest("hex")
  const manifest = Buffer.from(
    JSON.stringify({
      schema: "finny.dataset_evidence",
      version: 2,
      evidence_id: "dsv2-strict-runner-fixture",
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
        requested_start_inclusive: "2026-01-09T14:30:00Z",
        requested_end_inclusive: "2026-01-09T14:35:00Z",
        actual_start_inclusive: "2026-01-09T14:30:00Z",
        actual_end_inclusive: "2026-01-09T14:35:00Z",
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
        dividend_treatment: "not_in_price",
        corporate_action_status: "resolved",
        events: [],
      },
      hashes: {
        raw_bytes_sha256: csvHash,
        normalized_semantic_sha256: normalizedCsvSemanticHash(csvText),
        processed_bytes_sha256: csvHash,
        transformation_versions: { normalization: "finny-ohlcv-1" },
      },
      repair_lineage: null,
      qualification: { status: "strict_qualified", reason_codes: [] },
      schema_version: 1,
      source: "alpaca",
      requested_symbol: "SPY",
      actual_symbol: "SPY",
      requested_interval: "5m",
      actual_interval: "5m",
      requested_asset_class: "equity",
      actual_asset_class: "equity",
      requested_algorithm_name: "spy-5m",
      requested_start: "2026-01-09",
      requested_end: "2026-07-08",
      actual_start: "2026-01-09T14:30:00Z",
      actual_end: "2026-01-09T14:35:00Z",
      output_path: path.basename(csvPath),
      rows: 2,
      run_id: "extractor-run-1",
      usable_for_parent: "yes",
    }),
  )
  await fs.writeFile(csvPath, csv)
  await fs.writeFile(manifestPath, manifest)
  const evidence = await validateExistingDataExtractorEvidence({
    workspaceSlug: "spy-5m",
    dataRoot: root,
    context: {
      requested_symbol: "SPY",
      requested_interval: "5m",
      requested_asset_class: "equity",
      requested_algorithm_name: "spy-5m",
      requested_start: "2026-01-09",
      requested_end: "2026-07-08",
      request_id: "test-request",
    },
  })
  if (!evidence.found || !evidence.result?.ok || !evidence.dataset) {
    throw new Error(evidence.result?.text ?? "verified fixture was not accepted")
  }
  return evidence.dataset
}

async function legacyDataset(root: string): Promise<VerifiedDatasetRef> {
  const csvPath = path.join(root, "SPY_5m.csv")
  const manifestPath = path.join(root, "SPY_5m.manifest.json")
  await fs.writeFile(
    csvPath,
    [
      "timestamp,open,high,low,close,volume",
      "2026-01-09T14:30:00Z,590,591,589,590.5,100000",
      "2026-01-09T14:35:00Z,590.5,592,590,591.5,110000",
    ].join("\n"),
  )
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      schema_version: 1,
      source: "alpaca",
      requested_symbol: "SPY",
      actual_symbol: "SPY",
      requested_interval: "5m",
      actual_interval: "5m",
      requested_asset_class: "equity",
      actual_asset_class: "equity",
      requested_algorithm_name: "spy-5m",
      requested_start: "2026-01-09",
      requested_end: "2026-01-09",
      request_id: "legacy-test-request",
      actual_start: "2026-01-09T14:30:00Z",
      actual_end: "2026-01-09T14:35:00Z",
      output_path: path.basename(csvPath),
      rows: 2,
      run_id: "legacy-extractor-run",
      usable_for_parent: "yes",
    }),
  )
  const evidence = await validateExistingDataExtractorEvidence({
    workspaceSlug: "spy-5m",
    dataRoot: root,
    context: {
      requested_symbol: "SPY",
      requested_interval: "5m",
      requested_asset_class: "equity",
      requested_algorithm_name: "spy-5m",
      requested_start: "2026-01-09",
      requested_end: "2026-01-09",
      request_id: "legacy-test-request",
    },
  })
  if (!evidence.dataset) throw new Error(evidence.result?.text ?? "legacy fixture was not readable")
  return evidence.dataset
}

describe("BacktestRunner strict_v2 guardrails", () => {
  test("requires a schema-v4 executable risk contract for product eligibility", () => {
    expect(BacktestRunner._internalForTests.hasProductRiskContract({ risk: { max_drawdown_pct: 10 } })).toBe(false)
    expect(
      BacktestRunner._internalForTests.hasProductRiskContract({
        risk_contract: {
          sizing_stop_distance_pct: 2,
          protective_stop: { mode: "strategy_next_open" },
          drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 10 },
          max_positions: 1,
        },
      }),
    ).toBe(true)
  })

  test("keeps a provider-pipeline run as Crucible instead of downgrading it to research-only", () => {
    const results = { v2: { run_metadata: { existing: "value" } } } as unknown as BacktestRunner.Results

    BacktestRunner._internalForTests.markNonPromotableStrictRun({
      results,
      runId: "run_research_only",
      dataSource: { kind: "provider_fetch" },
      dataQualityMode: "strict",
      hasProductRiskContract: true,
    })

    expect(results).toMatchObject({
      runId: "run_research_only",
      eligibilityStatus: "backtested",
      v2: {
        run_metadata: {
          existing: "value",
          product_eligibility_blockers: ["qualification_operation_required"],
        },
      },
    })
  })

  test("rejects invalid strategy before any market data subprocess work", async () => {
    const r = await BacktestRunner.run({
      algorithm: algo({
        code: `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        if bar["close"] > bar["open"]:
            self.broker.buy(symbol, qty=1)
`,
      }),
      duration: "1m",
      interval: "1d",
      capital: "10000",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe("validation_failed")
      expect(r.error).toContain("LOOKAHEAD_BIAS_FLOW")
    }
  })

  test("rejects non-finite capital before any subprocess work", async () => {
    const r = await BacktestRunner.run({
      algorithm: algo(),
      duration: "1m",
      interval: "1d",
      capital: "NaN",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("invalid_input")
  })

  test("rejects custom backtestCode in strict_v2 mode", async () => {
    const r = await BacktestRunner.run({
      algorithm: algo({ backtestCode: "print('ann_sharpe: 999')" }),
      duration: "1m",
      interval: "1d",
      capital: "10000",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("unsafe_custom_runner")
  })

  test("rejects legacy_unsafe mode unless explicitly enabled for internal migration", async () => {
    const previous = process.env.FINNY_ALLOW_LEGACY_BACKTEST
    delete process.env.FINNY_ALLOW_LEGACY_BACKTEST
    try {
      const r = await BacktestRunner.run({
        algorithm: algo(),
        duration: "1m",
        interval: "1d",
        capital: "10000",
        engineMode: "legacy_unsafe",
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.kind).toBe("unsafe_custom_runner")
    } finally {
      if (previous === undefined) delete process.env.FINNY_ALLOW_LEGACY_BACKTEST
      else process.env.FINNY_ALLOW_LEGACY_BACKTEST = previous
    }
  })

  test("allows Crucible provider collection without evidence but keeps qualification evidence-bound", () => {
    expect(
      BacktestRunner.qualificationDataSourceIssue({
        engineMode: "strict_v2",
        sessionID: "ses_product_backtest",
        dataSource: { kind: "provider_fetch" },
      }),
    ).toBeUndefined()
    expect(
      BacktestRunner.qualificationDataSourceIssue({
        engineMode: "strict_v2",
        sessionID: "ses_product_backtest",
        dataSource: { kind: "provider_fetch" },
        qualification: qualificationInputForResearch(),
      }),
    ).toContain("Qualification requires")
  })

  test("launches provider preparation without DatasetEvidence", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-crucible-provider-"))
    try {
      let launched = 0
      const prepared = await BacktestRunner._internalForTests.prepareBacktestData({
        dataSource: { kind: "provider_fetch" },
        tmpDir: runDir,
        fetchProvider: async () => {
          launched += 1
          return {
            providerUsed: "fixture-provider",
            provenance: { mode: "provider_fetch", provider: "fixture-provider" },
          }
        },
      })
      expect(launched).toBe(1)
      expect(prepared).toEqual({
        providerUsed: "fixture-provider",
        provenance: { mode: "provider_fetch", provider: "fixture-provider" },
      })
      expect(JSON.stringify(prepared)).not.toContain("research_only")
    } finally {
      await fs.rm(runDir, { recursive: true, force: true })
    }
  })

  test("materializes an immutable Crucible provider manifest without DatasetEvidence", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-crucible-manifest-"))
    try {
      const csv = [
        "timestamp,open,high,low,close,volume",
        "2026-01-09T14:30:00Z,590,591,589,590.5,100000",
        "2026-01-09T14:35:00Z,590.5,592,590,591.5,110000",
      ].join("\n")
      await fs.writeFile(path.join(runDir, "ohlcv.csv"), csv)
      const rawHash = crypto.createHash("sha256").update(csv).digest("hex")
      await BacktestRunner._internalForTests.writeCrucibleProviderManifest({
        tmpDir: runDir,
        runId: "run-provider-1",
        algorithmName: "spy-sma",
        results: {
          v2: { start_ts: "2026-01-09T14:30:00Z", end_ts: "2026-01-09T14:35:00Z" },
        } as unknown as BacktestRunner.Results,
        provenance: {
          mode: "provider_fetch",
          provider: "finny-harness-fixture",
          raw_sha256: rawHash,
          snapshot_id: "crucible-data-provider-1",
          requested: {
            symbol: "SPY",
            asset_class: "equity",
            interval: "5m",
            start: "2026-01-09",
            end: "2026-01-09",
          },
          source_attempts: [{ provider: "finny-harness-fixture", status: "success", rows: 2 }],
        },
      })

      const manifest = JSON.parse(await fs.readFile(path.join(runDir, "data_extractor.manifest.json"), "utf8"))
      expect(manifest).toMatchObject({
        schema: "finny.crucible_data_manifest",
        source: "finny-harness-fixture",
        snapshot_id: "crucible-data-provider-1",
        requested_symbol: "SPY",
        requested_interval: "5m",
        requested_start: "2026-01-09",
        requested_end: "2026-01-09",
        actual_start: "2026-01-09",
        actual_end: "2026-01-09",
        rows: 2,
        run_id: "run-provider-1",
        usable_for_parent: "yes",
        strict_backtest_eligible: "yes",
        qualification: "unqualified",
        csv_sha256: rawHash,
      })
      expect(JSON.stringify(manifest)).not.toContain("DatasetEvidence")
    } finally {
      await fs.rm(runDir, { recursive: true, force: true })
    }
  })

  test("rejects structurally forged verified dataset references", async () => {
    const forged = {
      manifestPath: "/tmp/forged.manifest.json",
      manifestSha256: "0".repeat(64),
      csvPath: "/tmp/forged.csv",
      csvSha256: "0".repeat(64),
      identity: {
        runId: "forged",
        requestedAlgorithmName: "spy-5m",
        requestedSymbol: "SPY",
        actualSymbol: "SPY",
        requestedInterval: "5m",
        actualInterval: "5m",
        requestedAssetClass: "equity",
        actualAssetClass: "equity",
        requestedStart: "2026-01-09",
        requestedEnd: "2026-07-08",
        actualStart: "2026-01-09",
        actualEnd: "2026-07-08",
      },
    } as unknown as VerifiedDatasetRef
    const r = await BacktestRunner.run({
      algorithm: algo({ config: JSON.stringify({ symbol: "SPY" }) }),
      duration: "6m",
      interval: "5min",
      capital: "10000",
      sessionID: "ses_product_backtest",
      dataSource: { kind: "verified_artifact", dataset: forged },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe("data_evidence")
      expect(r.error).toContain("not issued by the data_extractor evidence gate")
    }
  })

  test("stages the exact verified CSV without calling the provider fetch branch", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-verified-source-"))
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-verified-run-"))
    try {
      const dataset = await verifiedDataset(sourceDir)
      let providerFetches = 0
      const prepared = await BacktestRunner._internalForTests.prepareBacktestData({
        dataSource: { kind: "verified_artifact", dataset },
        tmpDir: runDir,
        fetchProvider: async () => {
          providerFetches += 1
          throw new Error("provider fetch must not run")
        },
      })

      expect(providerFetches).toBe(0)
      expect(prepared.provenance.mode).toBe("verified_artifact")
      if (prepared.provenance.mode !== "verified_artifact") throw new Error("expected verified provenance")
      expect(prepared.provenance.extractor_run_id).toBe("extractor-run-1")
      expect(prepared.provenance.raw_manifest.sha256).toBe(dataset.manifestSha256)
      expect(prepared.provenance.raw_csv.sha256).toBe(dataset.csvSha256)
      expect(JSON.stringify(prepared.provenance)).not.toContain(sourceDir)
      const results = {
        v2: { run_metadata: { data_hash: "processed-engine-hash" } },
      } as unknown as BacktestRunner.Results
      BacktestRunner._internalForTests.attachDataSourceProvenance(results, prepared.provenance)
      expect(results.v2?.run_metadata).toMatchObject({
        data_hash: "processed-engine-hash",
        data_source_mode: "verified_artifact",
        raw_data_provenance: {
          extractor_run_id: "extractor-run-1",
          raw_manifest: { sha256: dataset.manifestSha256 },
          raw_csv: { sha256: dataset.csvSha256 },
        },
      })
      expect(await fs.readFile(path.join(runDir, "ohlcv.csv"))).toEqual(await fs.readFile(dataset.csvPath))
      expect(await fs.readFile(path.join(runDir, "data_extractor.manifest.json"))).toEqual(
        await fs.readFile(dataset.manifestPath),
      )
      await expect(fs.access(path.join(runDir, "_fetch_data.py"))).rejects.toThrow()
    } finally {
      await Promise.all([
        fs.rm(sourceDir, { recursive: true, force: true }),
        fs.rm(runDir, { recursive: true, force: true }),
      ])
    }
  })

  test("passes a hash-bound fund snapshot column to the strict strategy", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-snapshot-runner-"))
    try {
      const snapshot = JSON.stringify({ schema_version: 1, signal: "buy" }).replaceAll('"', '""')
      await Promise.all([
        fs.writeFile(path.join(sourceDir, "backtest.py"), BacktestRunner._internalForTests.DEFAULT_BACKTEST_PY),
        fs.writeFile(path.join(sourceDir, "finny_broker.py"), FINNY_BROKER_PY),
        fs.writeFile(path.join(sourceDir, "config.json"), JSON.stringify({ symbol: "SPY" })),
        fs.writeFile(
          path.join(sourceDir, "ohlcv.csv"),
          [
            "timestamp,open,high,low,close,volume,finny_snapshot_json",
            `2026-01-09T14:30:00Z,590,591,589,590.5,100000,"${snapshot}"`,
            "2026-01-09T14:35:00Z,590.5,592,590,591.5,110000,",
          ].join("\n"),
        ),
        fs.writeFile(
          path.join(sourceDir, "strategy.py"),
          `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        snapshot = bar.get("finny_snapshot")
        if snapshot and snapshot.get("signal") == "buy":
            self.broker.buy(symbol, qty=1)
`,
        ),
      ])
      const proc = Bun.spawn(
        [
          "python3",
          "backtest.py",
          "--csv",
          "ohlcv.csv",
          "--config",
          "config.json",
          "--interval",
          "5min",
          "--capital",
          "10000",
        ],
        { cwd: sourceDir, stdout: "pipe", stderr: "pipe" },
      )
      const [status, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(stderr).not.toContain("strategy error")
      expect(status).toBe(0)
      expect(stdout).toContain("diag_buy_attempts: 1")
      expect(stdout).toContain("diag_strategy_errors: 0")
    } finally {
      await fs.rm(sourceDir, { recursive: true, force: true })
    }
  })

  test("keeps V1 readable but refuses it for strict staging", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-legacy-evidence-source-"))
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-legacy-evidence-run-"))
    try {
      const dataset = await legacyDataset(sourceDir)
      expect(dataset.identity.qualification).toBe("research_only_legacy")
      await expect(
        BacktestRunner._internalForTests.prepareBacktestData({
          dataSource: { kind: "verified_artifact", dataset },
          tmpDir: runDir,
        }),
      ).rejects.toThrow("verified runs require DatasetEvidenceV2")
    } finally {
      await Promise.all([
        fs.rm(sourceDir, { recursive: true, force: true }),
        fs.rm(runDir, { recursive: true, force: true }),
      ])
    }
  })

  test("stages research_only verified evidence for non-promotable research runs", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-research-only-source-"))
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-research-only-run-"))
    try {
      const dataset = await verifiedDataset(sourceDir)
      // Simulate the BTC 1h case: full coverage with a couple statistical outliers.
      const researchOnly: typeof dataset = {
        ...dataset,
        identity: {
          ...dataset.identity,
          qualification: "research_only",
        },
      }
      const prepared = await BacktestRunner._internalForTests.prepareBacktestData({
        dataSource: { kind: "verified_artifact", dataset: researchOnly },
        tmpDir: runDir,
      })
      expect(prepared.provenance.mode).toBe("verified_artifact")
      if (prepared.provenance.mode !== "verified_artifact") throw new Error("expected verified provenance")
      expect(prepared.provenance.identity.qualification).toBe("research_only")
      expect(await fs.readFile(path.join(runDir, "ohlcv.csv"))).toEqual(await fs.readFile(researchOnly.csvPath))
    } finally {
      await Promise.all([
        fs.rm(sourceDir, { recursive: true, force: true }),
        fs.rm(runDir, { recursive: true, force: true }),
      ])
    }
  })

  test("rejects a verified CSV changed after evidence validation", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-verified-tamper-source-"))
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-verified-tamper-run-"))
    try {
      const dataset = await verifiedDataset(sourceDir)
      await fs.appendFile(dataset.csvPath, "2026-01-09T14:40:00Z,591.5,593,591,592.5,120000\n")
      let providerFetches = 0
      const prepare = BacktestRunner._internalForTests.prepareBacktestData({
        dataSource: { kind: "verified_artifact", dataset },
        tmpDir: runDir,
        fetchProvider: async () => {
          providerFetches += 1
          throw new Error("provider fetch must not run")
        },
      })

      await expect(prepare).rejects.toThrow("verified data CSV SHA-256 mismatch")
      expect(providerFetches).toBe(0)
      await expect(fs.access(path.join(runDir, "ohlcv.csv"))).rejects.toThrow()
    } finally {
      await Promise.all([
        fs.rm(sourceDir, { recursive: true, force: true }),
        fs.rm(runDir, { recursive: true, force: true }),
      ])
    }
  })
})
