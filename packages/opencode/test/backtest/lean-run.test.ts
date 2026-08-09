import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { buildLeanLauncherConfig } from "../../src/backtest/lean/engine-config"
import { leanExecutionProfileV1 } from "../../src/backtest/lean/contracts"
import { runLeanPhase } from "../../src/backtest/lean/run"
import { canonicalizeLeanArtifacts } from "../../src/backtest/lean/parse"
import type { LeanAdapterV1 } from "../../src/backtest/lean/runner"
import type { LeanAdapterContextV1 } from "../../src/backtest/lean/types"
import type { CrucibleResultV1 } from "../../src/backtest/lean/types"

const profile = leanExecutionProfileV1({
  assetClass: "equity",
  makerFeeBps: 1,
  takerFeeBps: 2,
  slippageBps: 3,
  maxLeverage: 2,
  maintenanceMarginPct: 0.25,
  shortingEnabled: false,
  dataFeedWorkers: 1,
})

function stubAdapter(overrides: Partial<LeanAdapterV1> = {}): LeanAdapterV1 {
  return {
    profileId: "lean_python",
    probeReady: () => ({ ready: true, reasons: [] }),
    run: async () => ({
      ok: true,
      artifacts: {
        schema: "finny.lean_run_artifacts",
        version: 1,
        orders: [{ symbol: "SPY", quantity: 10 }],
        fills: [{ symbol: "SPY", quantity: 10, price: 100 }],
        rejections: [],
        equityCurve: [
          { timestamp: "2026-01-01T00:00:00Z", equity: 10000 },
          { timestamp: "2026-01-02T00:00:00Z", equity: 10100 },
        ],
        rawStatistics: { "Total Orders": 1, "Net Profit": 0.01, "Drawdown": -0.02, "Sharpe Ratio": 1.5, "Total Fees": 1 },
        leanResultPath: "",
        leanSummaryPath: "",
      },
      container: {
        imageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        leanCommit: "c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
        exitCode: 0,
      },
    }),
    ...overrides,
  }
}

function context(resultsDir: string, scratchDir: string): LeanAdapterContextV1 {
  return {
    plan: {
      schema: "finny.experiment_plan",
      version: 2,
      planId: "plan-test",
      planHash: "a".repeat(64),
      request: { requestId: "r", requestVersion: 1, requestHash: "b".repeat(64), interval: "1h", requestedStart: "2026-01-01", requestedEnd: "2026-01-31" },
      candidate: { candidateId: "c", codeHash: "c".repeat(64), configHash: "d".repeat(64), warmupBars: 24, declaredSearchBudget: 1 },
      runtime: {
        profileId: "lean_python",
        profileHash: "e".repeat(64),
        sourceTreeHash: "f".repeat(64),
        adapterHash: "g".repeat(64),
        executionProfileHash: "h".repeat(64),
        imageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        leanCommit: "c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0",
        leanConfigHash: "i".repeat(64),
      },
      datasets: [],
      datasetCompositeHash: "j".repeat(64),
      interval: "1h",
      warmupBars: 24,
      declaredSearchBudget: 1,
      orderPolicyVersion: 1,
      calendarPolicyVersion: "finny-calendars-2026.1",
      canonicalMetricsVersion: 1,
      qualificationPolicyId: "p",
      qualificationPolicyHash: "k".repeat(64),
      sealedHoldoutPolicy: "single_approved_event",
      windows: {
        warmup: { start: "", end: "", bars: 0, sessions: 0, firstSessionId: "", lastSessionId: "" },
        exploratory: { start: "2026-01-01", end: "2026-01-15", bars: 100, sessions: 10, firstSessionId: "", lastSessionId: "" },
        validation: { start: "2026-01-16", end: "2026-01-22", bars: 50, sessions: 5, firstSessionId: "", lastSessionId: "" },
        confirmatory: { start: "2026-01-23", end: "2026-01-31", bars: 50, sessions: 5, firstSessionId: "", lastSessionId: "" },
      },
    } as any,
    bundle: {
      schema: "finny.lean_runtime_bundle",
      version: 1,
      profile: { schema: "finny.runtime_profile", version: 1, profileId: "lean_python", profileHash: "e".repeat(64) },
      source: { schema: "finny.strategy_source", version: 1, profileId: "lean_python", files: [], sourceTreeHash: "f".repeat(64) },
      executionProfile: profile,
      image: {
        schema: "finny.lean_image_identity",
        version: 1,
        imageRef: "ghcr.io/finny-ai/lean-engine",
        imageDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        leanCommit: "c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0",
        architectures: ["linux/amd64", "linux/arm64"],
        sbomSha256: "",
        provenanceSha256: "",
      },
      leanConfigHash: "i".repeat(64),
      adapterHash: "g".repeat(64),
      runtimeHash: "r".repeat(64),
    },
    dataBundle: {
      schema: "finny.lean_data_bundle",
      version: 1,
      phase: "exploratory",
      interval: "1h",
      assetFamily: "equity",
      calendars: [],
      symbols: [],
      fillForward: false,
      normalizationMode: "raw",
      bundleHash: "b".repeat(64),
    },
    phase: "exploratory",
    window: { start: "2026-01-01", end: "2026-01-15" },
    seed: 42,
    capital: 10000,
    sourceDir: "/tmp/lean-source",
    resultsDir,
    scratchDir,
  }
}

describe("LEAN engine config", () => {
  test("is deterministic and hashed", () => {
    const a = buildLeanLauncherConfig({
      profile,
      assetFamily: "equity",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      cash: 10000,
      algorithmTypeName: "Main",
      algorithmLanguage: "Python",
      algorithmLocation: "main.py",
      dataFolder: "/Lean/Data",
      resultsFolder: "/Results",
      seed: 42,
      dataFeedWorkers: 1,
    })
    const b = buildLeanLauncherConfig({
      profile,
      assetFamily: "equity",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      cash: 10000,
      algorithmTypeName: "Main",
      algorithmLanguage: "Python",
      algorithmLocation: "main.py",
      dataFolder: "/Lean/Data",
      resultsFolder: "/Results",
      seed: 42,
      dataFeedWorkers: 1,
    })
    expect(a.json).toBe(b.json)
    expect(a.configHash).toMatch(/^[a-f0-9]{64}$/)
    expect(a.config.environment).toBe("backtesting")
    expect(a.config["close-automatically"]).toBe(true)
    expect(a.config["job-user-id"]).toBe("0")
  })
})

describe("LEAN phase run facade", () => {
  test("writes canonical artifacts and returns a CrucibleResultV1", async () => {
    const resultsDir = `/tmp/finny-lean-run-${Math.random().toString(36).slice(2)}/results`
    const scratchDir = `/tmp/finny-lean-run-${Math.random().toString(36).slice(2)}/scratch`
    await fs.mkdir(resultsDir, { recursive: true })
    await fs.mkdir(scratchDir, { recursive: true })
    const outcome = await runLeanPhase({
      adapter: stubAdapter(),
      context: context(resultsDir, scratchDir),
      dataBundle: context(resultsDir, scratchDir).dataBundle,
      canonicalize: (result) =>
        canonicalizeLeanArtifacts({
          artifacts: result.artifacts,
          startingEquity: 10000,
          engineVersion: "lean",
        }),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect((outcome.result as CrucibleResultV1).totalTrades).toBe(1)
    expect(await fs.readFile(path.join(resultsDir, "orders.csv"), "utf8")).toContain("SPY")
    expect(await fs.readFile(path.join(resultsDir, "fills.csv"), "utf8")).toContain("100")
    expect(await fs.readFile(path.join(resultsDir, "equity.csv"), "utf8")).toContain("10100")
    const results = JSON.parse(await fs.readFile(path.join(resultsDir, "results.json"), "utf8"))
    expect(results.schema).toBe("finny.crucible_result")
    expect(results.runKind).toBe("crucible_2_0")
  })

  test("propagates typed adapter failures without fallback", async () => {
    const resultsDir = `/tmp/finny-lean-run-${Math.random().toString(36).slice(2)}/results`
    const scratchDir = `/tmp/finny-lean-run-${Math.random().toString(36).slice(2)}/scratch`
    await fs.mkdir(resultsDir, { recursive: true })
    await fs.mkdir(scratchDir, { recursive: true })
    const outcome = await runLeanPhase({
      adapter: stubAdapter({
        run: async () => ({ ok: false as const, kind: "image_unavailable", error: "pinned image missing" }),
      }),
      context: context(resultsDir, scratchDir),
      dataBundle: context(resultsDir, scratchDir).dataBundle,
      canonicalize: (result) =>
        canonicalizeLeanArtifacts({
          artifacts: result.artifacts,
          startingEquity: 10000,
          engineVersion: "lean",
        }),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe("image_unavailable")
  })
})
