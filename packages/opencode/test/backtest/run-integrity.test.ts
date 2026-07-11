import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Algorithm } from "../../src/algorithm"
import { evaluateBacktestQuality } from "../../src/backtest/evaluation"
import { composeBacktestVerdict, deriveWalkForwardVerdict } from "../../src/backtest/verdict"
import {
  currentAlgorithmHashes,
  publishStrictRun,
  sha256Text,
  stableStringify,
  strictRunDir,
  verifyPromotion,
  verifyStrictRunDir,
  writePaperApproval,
} from "../../src/backtest/run-integrity"
import { bindObservedStrictRuns, inspectStrategyResults } from "../../script/headless/run-artifacts"

const cleanups: string[] = []
const originalFinnyHome = process.env.FINNY_HOME

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

const hash = (value: string) => sha256Text(value)
const ENGINE_TREE = [{ path: "cli.py", sha256: hash("engine"), bytes: 6 }]
const METRICS = {
  totalReturn: 0.1,
  maxDrawdown: 0.05,
  annualizedVolatility: 0.12,
  sharpeRatio: 1.2,
  endingEquity: 11_000,
  totalTrades: 40,
  winRate: 0.55,
  profitFactor: 1.8,
  benchmarkReturn: 0.02,
  benchmarkSharpeRatio: 0.8,
  benchmarkMaxDrawdown: 0.08,
  alpha: 0.08,
  runKind: "crucible_2_0" as const,
  productLabel: "Crucible 2.0",
  diagnostics: {
    barsProcessed: 1_000,
    buyAttempts: 40,
    sellAttempts: 40,
    rejectedOrders: 0,
    rejectionReasons: {},
    priceFirst: 100,
    priceLast: 110,
    priceRangePct: 0.1,
    strategyErrors: 0,
  },
  v2: {
    walk_forward: {
      n_folds: 5,
      is_sharpe_mean: 1.4,
      oos_sharpe_mean: 1.1,
      oos_decay: 0.78,
      is_to_oos_sharpe_change: -0.3,
      flag_threshold: 0.7,
      flagged: false,
      flag_reasons: [],
      deflated_sharpe: 0.8,
      probabilistic_sharpe: 0.9,
      stitched_oos_return: 0.08,
      stitched_oos_sharpe: 1.1,
      stitched_oos_trades: 30,
      stitched_oos_bars: 300,
      stitched_oos_coverage: 1,
      ruined_folds: 0,
      multiple_testing_trials: 1,
      folds: [],
    },
    consistency: {
      label: "consistent" as const,
      confidence: "high" as const,
      equity_curve_r2: 0.9,
      k_ratio: 1,
      fold_icir: 1,
      rolling_sharpe_mean: 1,
      rolling_sharpe_min: 0,
      rolling_sharpe_max: 2,
      period_rule: "1ME",
      pct_positive_periods: 0.7,
      max_consecutive_losing_periods: 1,
      top_period_return_share: 0.2,
      n_periods: 12,
    },
    alpha_decay: {
      label: "stable" as const,
      confidence: "high" as const,
      mann_kendall: { trend: "no_trend" as const, s: 0, z: 0, p_value: 1, n: 120 },
      fold_slope: { slope: 0, r_squared: 0, n: 5 },
      breakeven: {
        status: "no_measured_decay" as const,
        months: null,
        slope: 0,
        latest_gross_expectancy: 10,
        per_trade_cost: 1,
        n_months: 6,
        n_trades: 30,
      },
    },
  },
} as any
const RECOMMENDATION = composeBacktestVerdict({
  quality: evaluateBacktestQuality(METRICS),
  walkForward: deriveWalkForwardVerdict(METRICS.v2.walk_forward),
  consistency: METRICS.v2.consistency,
  decay: METRICS.v2.alpha_decay,
})

function identity(overrides: Record<string, unknown> = {}) {
  return {
    algorithmId: "algo-1",
    algorithmVersion: 1,
    strategyHash: hash("strategy"),
    savedConfigHash: hash("saved-config"),
    effectiveConfigHash: hash(stableStringify({})),
    documentHashes: {
      mission: hash("mission"),
      preferences: hash("preferences"),
      decisions: hash("decisions"),
      reasoning: hash("reasoning"),
    },
    riskContractHash: hash("risk"),
    rawDataHash: hash("id\n"),
    processedDataHash: hash("id\n"),
    manifestHash: hash("{}\n"),
    engineTreeHash: hash(stableStringify(ENGINE_TREE)),
    assetProfileHash: hash(stableStringify({})),
    executionProfileHash: hash(stableStringify({})),
    seed: 42,
    dateWindow: { start: "2026-01-09", end: "2026-07-08", interval: "5min" },
    ...overrides,
  }
}

async function fixtureArtifacts(root: string) {
  const source = path.join(root, "source")
  await fs.mkdir(source)
  for (const name of ["results.json", "data_extractor.manifest.json", "ohlcv.csv", "processed_ohlcv.csv", "orders.csv", "fills.csv", "rejections.csv"]) {
    await fs.writeFile(path.join(source, name), name.endsWith(".json") ? "{}\n" : "id\n")
  }
  return source
}

async function publishFixture(root: string, identityInput = identity(), recommendation = RECOMMENDATION) {
  const source = await fixtureArtifacts(root)
  const finalDir = path.join(root, "runs", "run-1")
  return publishStrictRun({
    finalDir,
    runId: "run-1",
    identity: identityInput as any,
    recommendation,
    artifacts: [
      { source: path.join(source, "results.json"), path: "results.json" },
      { source: path.join(source, "data_extractor.manifest.json"), path: "data_extractor.manifest.json" },
      { source: path.join(source, "ohlcv.csv"), path: "ohlcv.csv" },
      { source: path.join(source, "processed_ohlcv.csv"), path: "processed_ohlcv.csv" },
      { source: path.join(source, "orders.csv"), path: "orders.csv" },
      { source: path.join(source, "fills.csv"), path: "fills.csv" },
      { source: path.join(source, "rejections.csv"), path: "rejections.csv" },
    ],
    jsonArtifacts: {
      "validation.json": { valid: true },
      "metrics.json": METRICS,
      "data_quality.json": {},
      "execution_assumptions.json": {},
      "execution_profile.json": {},
      "effective_config.json": {},
      "engine_tree.json": ENGINE_TREE,
      "asset_spec.json": {},
    },
    requiredArtifacts: [],
    createdAt: "2026-07-09T00:00:00.000Z",
  })
}

describe("strict run integrity", () => {

  test("harness binding rejects a verifier-valid run substituted for another saved candidate or scenario", async () => {
    const root = await tempDir("finny-run-substitution-")
    const published = await publishFixture(
      root,
      identity({
        algorithmId: "substituted-algorithm",
        dateWindow: { start: "2026-02-01", end: "2026-06-01", interval: "1h" },
      }),
    )
    const inspected = await inspectStrategyResults(root)
    expect(inspected.issues).toEqual([])
    expect(inspected.runs).toHaveLength(1)

    const issues = bindObservedStrictRuns({
      finnyHome: root,
      savedCandidates: [{ name: "spy-sma-crossover", algorithmId: "expected-algorithm", version: 1 }],
      backtests: [{ algorithmName: "spy-sma-crossover", runId: "run-1", artifactDir: published.dir }],
      runs: inspected.runs,
      scenario: {
        symbols: ["SPY"],
        assetClass: "equity",
        interval: "5m",
        startDate: "2026-01-09",
        endDate: "2026-07-08",
      },
    })
    const messages = issues.map((issue) => issue.message).join("\n")
    expect(messages).toContain("algorithmId does not match")
    expect(messages).toContain("date window does not match")
    expect(messages).toContain("asset symbol does not match")
    expect(messages).toContain("data manifest request does not match")
  })
  test("publishes atomically with a canonical identity and immutable recommendation", async () => {
    const root = await tempDir("finny-run-integrity-")
    const published = await publishFixture(root)
    const verified = await verifyStrictRunDir(published.dir)
    expect(verified.ok).toBe(true)
    expect(verified.run?.recommendation.verdict).toBe("recommended_for_paper")
    expect((verified.run as any)?.eligibilityStatus).toBeUndefined()
    expect(verified.run?.identity.manifestHash).toBe(hash("{}\n"))
    expect(verified.manifest?.manifestHash).not.toBe(verified.run?.identity.manifestHash)
    expect(await fs.readdir(path.dirname(published.dir))).toEqual(["run-1"])
    await expect(publishFixture(root)).rejects.toThrow()
  })

  test("rejects partial, empty-hash, and tampered bundles", async () => {
    const legacyRoot = await tempDir("finny-run-legacy-")
    const legacyDir = path.join(legacyRoot, "legacy-run")
    await fs.mkdir(legacyDir)
    await fs.writeFile(path.join(legacyDir, "run.json"), JSON.stringify({ runId: "legacy-run", eligibilityStatus: "paper_eligible" }))
    const legacy = await verifyStrictRunDir(legacyDir)
    expect(legacy.ok).toBe(false)
    expect(legacy.errors.join(" ")).toContain("metadata")

    const missingRoot = await tempDir("finny-run-missing-")
    const missingSource = await fixtureArtifacts(missingRoot)
    const missingFinal = path.join(missingRoot, "runs", "run-1")
    await expect(publishStrictRun({
      finalDir: missingFinal,
      runId: "run-1",
      identity: identity() as any,
      recommendation: { verdict: "weak", reasons: [] },
      artifacts: [
        { source: path.join(missingSource, "results.json"), path: "results.json" },
        { source: path.join(missingSource, "data_extractor.manifest.json"), path: "data_extractor.manifest.json" },
        { source: path.join(missingSource, "ohlcv.csv"), path: "ohlcv.csv" },
        { source: path.join(missingSource, "processed_ohlcv.csv"), path: "processed_ohlcv.csv" },
        { source: path.join(missingSource, "fills.csv"), path: "fills.csv" },
        { source: path.join(missingSource, "rejections.csv"), path: "rejections.csv" },
      ],
      jsonArtifacts: {
        "validation.json": { valid: true },
        "metrics.json": METRICS,
        "data_quality.json": {},
        "execution_assumptions.json": {},
        "execution_profile.json": {},
        "effective_config.json": {},
        "engine_tree.json": ENGINE_TREE,
        "asset_spec.json": {},
      },
      requiredArtifacts: [],
    })).rejects.toThrow("orders.csv")
    await expect(fs.stat(missingFinal)).rejects.toThrow()

    const emptyRoot = await tempDir("finny-run-empty-hash-")
    await expect(publishFixture(emptyRoot, identity({ engineTreeHash: "" }))).rejects.toThrow("engineTreeHash")
    await expect(fs.stat(path.join(emptyRoot, "runs", "run-1"))).rejects.toThrow()

    const wrongDataRoot = await tempDir("finny-run-wrong-data-")
    await expect(publishFixture(wrongDataRoot, identity({ rawDataHash: hash("other bytes") }))).rejects.toThrow(
      "rawDataHash",
    )
    await expect(fs.stat(path.join(wrongDataRoot, "runs", "run-1"))).rejects.toThrow()

    const wrongManifestRoot = await tempDir("finny-run-wrong-manifest-")
    await expect(publishFixture(wrongManifestRoot, identity({ manifestHash: hash("other manifest") }))).rejects.toThrow(
      "manifestHash",
    )

    const forgedRecommendationRoot = await tempDir("finny-run-wrong-recommendation-")
    await expect(
      publishFixture(forgedRecommendationRoot, identity(), { verdict: "recommended_for_paper", reasons: ["forged"] }),
    ).rejects.toThrow("recommendation")

    const tamperedRoot = await tempDir("finny-run-tamper-")
    const published = await publishFixture(tamperedRoot)
    await fs.writeFile(path.join(published.dir, "metrics.json"), "{\"totalReturn\":99}\n")
    const tampered = await verifyStrictRunDir(published.dir)
    expect(tampered.ok).toBe(false)
    expect(tampered.errors.join(" ")).toContain("metrics.json")
  })


async function preparePromotionFixture(home: string) {
  const algorithm: Algorithm.Info = {
    algorithmId: "algo-exact",
    userId: "user-1",
    name: "Exact Run",
    code: "class Strategy:\n    pass\n",
    language: "python",
    version: 1,
    status: "draft",
    config: "{\"symbol\":\"SPY\"}",
    reasoning: "original reasoning",
    time_created: 1,
    time_updated: 1,
  }
  const algoRoot = path.join(home, "algorithms", algorithm.algorithmId)
  const versionRoot = path.join(algoRoot, "v01")
  await fs.mkdir(versionRoot, { recursive: true })
  await fs.writeFile(path.join(versionRoot, "strategy.py"), algorithm.code)
  await fs.writeFile(path.join(versionRoot, "config.json"), algorithm.config!)
  await fs.writeFile(path.join(versionRoot, "mission.md"), "mission")
  await fs.writeFile(path.join(versionRoot, "prefs.md"), "preferences")
  await fs.writeFile(path.join(versionRoot, "decisions.md"), "decisions")
  await fs.writeFile(path.join(versionRoot, "reasoning.md"), algorithm.reasoning!)
  await fs.writeFile(path.join(versionRoot, "risk.json"), "risk")
  const current = await currentAlgorithmHashes(algorithm)
  const source = await fixtureArtifacts(home)
  const dir = strictRunDir(algorithm, "run-exact")
  const published = await publishStrictRun({
    finalDir: dir,
    runId: "run-exact",
    identity: {
      ...identity({ algorithmId: algorithm.algorithmId, algorithmVersion: 1 }),
      strategyHash: current.strategyHash,
      savedConfigHash: current.savedConfigHash,
      documentHashes: current.documentHashes,
      riskContractHash: current.riskContractHash,
    } as any,
    recommendation: RECOMMENDATION,
    artifacts: [
      { source: path.join(source, "results.json"), path: "results.json" },
      { source: path.join(source, "data_extractor.manifest.json"), path: "data_extractor.manifest.json" },
      { source: path.join(source, "ohlcv.csv"), path: "ohlcv.csv" },
      { source: path.join(source, "processed_ohlcv.csv"), path: "processed_ohlcv.csv" },
      { source: path.join(source, "orders.csv"), path: "orders.csv" },
      { source: path.join(source, "fills.csv"), path: "fills.csv" },
      { source: path.join(source, "rejections.csv"), path: "rejections.csv" },
    ],
    jsonArtifacts: {
      "validation.json": { valid: true },
      "metrics.json": METRICS,
      "data_quality.json": {},
      "execution_assumptions.json": {},
      "execution_profile.json": {},
      "effective_config.json": {},
      "engine_tree.json": ENGINE_TREE,
      "asset_spec.json": {},
    },
    requiredArtifacts: [],
  })
  return { algorithm, versionRoot, dir, published }
}

  test("binds paper approval to the exact current version and fails live closed", async () => {
    const home = await tempDir("finny-run-promotion-")
    process.env.FINNY_HOME = home
    const { algorithm, versionRoot, dir, published } = await preparePromotionFixture(home)

    expect((await verifyPromotion({ algorithm, runId: "run-exact", mode: "paper" })).ok).toBe(false)
    const runJsonBeforeApproval = await fs.readFile(path.join(dir, "run.json"), "utf8")
    const authority = {
      workflowId: "wf-exact",
      challengeId: "approval-exact",
      scopeHash: hash("paper-scope"),
      runId: published.run.runId,
      identityHash: published.run.identityHash,
      grantedAt: Date.parse("2026-07-09T00:00:00.000Z"),
      questionRequestId: "question-exact",
    }
    const first = await writePaperApproval({ dir, run: published.run, authority })
    const second = await writePaperApproval({ dir, run: published.run, authority, approvedAt: "2026-07-10T00:00:00.000Z" })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.approval).toEqual(first.approval)
    expect(await fs.readFile(path.join(dir, "run.json"), "utf8")).toBe(runJsonBeforeApproval)
    expect((await verifyPromotion({ algorithm, runId: "run-exact", mode: "paper" })).ok).toBe(false)
    expect((await verifyPromotion({ algorithm, runId: "run-exact", mode: "paper", controllerApproval: authority })).ok).toBe(true)
    const approvalFile = path.join(dir, "approval.json")
    const approvalReceipt = await fs.readFile(approvalFile, "utf8")
    await fs.writeFile(approvalFile, approvalReceipt.replace(authority.challengeId, "handcrafted-challenge"))
    expect((await verifyPromotion({ algorithm, runId: "run-exact", mode: "paper", controllerApproval: authority })).ok).toBe(false)
    await fs.writeFile(approvalFile, approvalReceipt)
    expect((await verifyPromotion({ algorithm, runId: "run-exact", mode: "live" })).errors.join(" ")).toContain("live_eligible")
    await fs.writeFile(
      path.join(dir, "live-eligibility.json"),
      JSON.stringify({
        schema: "finny.run_approval",
        version: 1,
        runId: published.run.runId,
        identityHash: published.run.identityHash,
        decision: "live_eligible",
        approvedAt: "2026-07-09T00:00:00.000Z",
        approvedVia: "handcrafted",
      }),
    )
    expect((await verifyPromotion({ algorithm, runId: "run-exact", mode: "live" })).ok).toBe(false)

    const wrongVersion = { ...algorithm, version: 2 }
    expect((await verifyPromotion({ algorithm: wrongVersion, runId: "run-exact", mode: "paper", controllerApproval: authority })).ok).toBe(false)
    await fs.writeFile(path.join(versionRoot, "mission.md"), "changed mission")
    expect((await verifyPromotion({ algorithm, runId: "run-exact", mode: "paper", controllerApproval: authority })).errors.join(" ")).toContain("mission document changed")
  })
})
