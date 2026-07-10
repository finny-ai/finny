import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { BacktestRunner } from "../../src/backtest/runner"
import type { Algorithm } from "../../src/algorithm"
import { validateExistingDataExtractorEvidence, type VerifiedDatasetRef } from "../../src/data/data-extractor-evidence"

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
  const manifest = Buffer.from(
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

describe("BacktestRunner strict_v2 guardrails", () => {
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

  test("requires a verified artifact for session-backed strict runs", async () => {
    const r = await BacktestRunner.run({
      algorithm: algo(),
      duration: "1m",
      interval: "1d",
      capital: "10000",
      sessionID: "ses_product_backtest",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe("data_evidence")
      expect(r.error).toContain("require the exact verified data_extractor artifact")
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
