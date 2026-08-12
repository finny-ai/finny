import { describe, expect, test } from "bun:test"
import {
  LEAN_PINNED_COMMIT,
  LEAN_PINNED_IMAGE_DIGEST,
  leanExecutionProfileV1,
  leanRuntimeBundleV1,
  runtimeProfileV1,
  strategySourceV1,
  verifyExecutionProfile,
} from "../../src/backtest/lean/contracts"
import {
  compileExperimentPlanV2,
  ExperimentPlanV2CompileError,
  planDatasetCompositeHash,
  verifyExperimentPlanV2,
  type ExperimentPlanRequestV1,
} from "../../src/backtest/experiment-plan"
import { materializeLeanDataBundle } from "../../src/backtest/lean/materialize"
import { embedRuntimeConfig, runtimeFromConfig, validateLeanSourceManifest } from "../../src/backtest/lean/select"
import { crucibleResultFromEngineV2 } from "../../src/backtest/lean/canonical"
import { canonicalizeLeanArtifacts } from "../../src/backtest/lean/parse"
import type { EngineV2 } from "../../src/backtest/results"

const request: ExperimentPlanRequestV1 = {
  requestId: "req-1",
  requestVersion: 1,
  requestHash: "a".repeat(64),
  interval: "1h",
  requestedStart: "2026-01-01",
  requestedEnd: "2026-06-30",
}

function runtime(profileId: "lean_python" | "lean_csharp") {
  return {
    profileId,
    profileHash: "b".repeat(64),
    sourceTreeHash: "c".repeat(64),
    adapterHash: "d".repeat(64),
    executionProfileHash: "e".repeat(64),
    imageDigest: LEAN_PINNED_IMAGE_DIGEST,
    leanCommit: LEAN_PINNED_COMMIT,
    leanConfigHash: "f".repeat(64),
  }
}

function dataset(symbol: string, assetClass: "equity" | "crypto_spot" = "equity") {
  return {
    canonicalSymbol: symbol,
    assetClass,
    datasetEvidenceId: `dataset-${symbol}`,
    datasetHash: `${symbol}`.padEnd(64, "0"),
    manifestHash: "m".repeat(64),
    scheduleHash: "s".repeat(64),
    actualStart: "2026-01-01",
    actualEnd: "2026-06-30",
  }
}

const policy = {
  policyId: "policy-1",
  policyHash: "p".repeat(64),
}

describe("LEAN runtime contracts", () => {
  test("runtime profiles hash deterministically and default to finny_python", () => {
    expect(runtimeProfileV1("lean_python")).toEqual(runtimeProfileV1("lean_python"))
    expect(runtimeProfileV1("lean_python").profileHash).not.toBe(runtimeProfileV1("finny_python").profileHash)
    expect(runtimeFromConfig(undefined)).toMatchObject({
      profile: { profileId: "finny_python" },
      explicitlyConfigured: false,
      issues: [],
    })
    expect(runtimeFromConfig('{"runtime":{"profile":{"profileId":"lean_csharp"}}}')).toMatchObject({
      profile: { profileId: "lean_csharp" },
      explicitlyConfigured: true,
      issues: [],
    })
  })

  test("explicit invalid and cloud runtimes never coerce to the local Finny engine", () => {
    expect(runtimeFromConfig('{"runtime":{"profile":{"profileId":"lean_pythno"}}}').issues).toEqual([
      'unsupported runtime profile "lean_pythno"',
    ])
    expect(runtimeFromConfig('{"runtime":{"profile":{"profileId":"qc_cloud"}}}')).toMatchObject({
      profile: { profileId: "qc_cloud" },
      explicitlyConfigured: true,
      issues: [],
    })
    const valid = runtimeProfileV1("lean_python")
    expect(
      runtimeFromConfig(
        JSON.stringify({ runtime: { profile: { ...valid, profileHash: "0".repeat(64) } } }),
      ).issues,
    ).toEqual(["runtime profile hash does not match profile lean_python"])
  })

  test("strategy source manifests reject unsafe paths", () => {
    expect(() =>
      strategySourceV1({ profileId: "lean_python", files: [{ path: "../evil.py", sha256: "a".repeat(64), bytes: 1 }] }),
    ).toThrow()
    const source = strategySourceV1({
      profileId: "lean_python",
      files: [{ path: "main.py", sha256: "a".repeat(64), bytes: 12 }],
    })
    expect(source.sourceTreeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(validateLeanSourceManifest(source, "lean_python")).toEqual([])
    expect(validateLeanSourceManifest(source, "lean_csharp")).not.toEqual([])
  })

  test("execution profiles are verified and hashed", () => {
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
    expect(verifyExecutionProfile(profile)).toEqual([])
    expect(profile.executionProfileHash).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyExecutionProfile({ ...profile, fillForwardEnabled: true } as any)).not.toEqual([])
    expect(verifyExecutionProfile({ ...profile, normalizationMode: "adjusted" } as any)).not.toEqual([])
  })

  test("runtime bundles bind source and image identity", () => {
    const source = strategySourceV1({
      profileId: "lean_python",
      files: [{ path: "main.py", sha256: "a".repeat(64), bytes: 12 }],
    })
    const bundle = leanRuntimeBundleV1({
      profile: runtimeProfileV1("lean_python"),
      source,
      executionProfile: leanExecutionProfileV1({
        assetClass: "equity",
        makerFeeBps: 0,
        takerFeeBps: 1,
        slippageBps: 0,
        maxLeverage: 1,
        maintenanceMarginPct: 0.5,
        shortingEnabled: false,
        dataFeedWorkers: 1,
      }),
      image: {
        schema: "finny.lean_image_identity",
        version: 1,
        imageRef: "ghcr.io/finny-ai/lean-engine",
        imageDigest: LEAN_PINNED_IMAGE_DIGEST,
        leanCommit: LEAN_PINNED_COMMIT,
        architectures: ["linux/amd64", "linux/arm64"],
        sbomSha256: "",
        provenanceSha256: "",
      },
      leanConfig: '{"environment":"backtesting"}',
      adapterHash: "ad".repeat(32),
    })
    expect(bundle.runtimeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(() =>
      leanRuntimeBundleV1({
        ...bundle,
        profile: runtimeProfileV1("finny_python"),
        source,
        executionProfile: bundle.executionProfile,
        image: bundle.image,
        leanConfig: "{}",
        adapterHash: "ad".repeat(32),
      }),
    ).toThrow()
  })
})

describe("ExperimentPlanV2", () => {
  const windows = {
    warmup: { start: "2026-01-01", end: "2026-01-01", bars: 24, sessions: 1, firstSessionId: "2026-01-01", lastSessionId: "2026-01-01" },
    exploratory: { start: "2026-01-02", end: "2026-02-01", bars: 120, sessions: 20, firstSessionId: "2026-01-02", lastSessionId: "2026-02-01" },
    validation: { start: "2026-02-02", end: "2026-02-22", bars: 40, sessions: 15, firstSessionId: "2026-02-02", lastSessionId: "2026-02-22" },
    confirmatory: { start: "2026-02-23", end: "2026-03-31", bars: 40, sessions: 20, firstSessionId: "2026-02-23", lastSessionId: "2026-03-31" },
  }

  test("compiles and verifies a valid LEAN plan", () => {
    const plan = compileExperimentPlanV2({
      request,
      candidate: { candidateId: "cand-1", codeHash: "a".repeat(64), configHash: "b".repeat(64), warmupBars: 24, declaredSearchBudget: 1 },
      runtime: runtime("lean_python"),
      datasets: [dataset("SPY")],
      interval: "1h",
      warmupBars: 24,
      declaredSearchBudget: 1,
      calendarPolicyVersion: "finny-calendars-2026.1",
      qualificationPolicy: policy as any,
      windows,
    })
    expect(plan.planId).toMatch(/^plan-[a-f0-9]{24}$/)
    expect(plan.datasetCompositeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(planDatasetCompositeHash([dataset("SPY")])).toBe(plan.datasetCompositeHash)
    expect(verifyExperimentPlanV2(plan)).toEqual([])
  })

  test("rejects empty, oversized, and mixed universes", () => {
    const base = {
      request,
      candidate: { candidateId: "cand-1", codeHash: "a".repeat(64), configHash: "b".repeat(64), warmupBars: 24, declaredSearchBudget: 1 },
      runtime: runtime("lean_python"),
      interval: "1h",
      warmupBars: 24,
      declaredSearchBudget: 1,
      calendarPolicyVersion: "finny-calendars-2026.1",
      qualificationPolicy: policy as any,
      windows,
    }
    expect(() => compileExperimentPlanV2({ ...base, datasets: [] })).toThrow(ExperimentPlanV2CompileError)
    const many = Array.from({ length: 21 }, (_, i) => dataset(`S${i}`))
    expect(() => compileExperimentPlanV2({ ...base, datasets: many })).toThrow(ExperimentPlanV2CompileError)
    expect(() =>
      compileExperimentPlanV2({ ...base, datasets: [dataset("SPY"), { ...dataset("BTC"), assetClass: "crypto_spot" }] }),
    ).toThrow(/mix equity and crypto/)
  })

  test("verification rejects placeholder image digests and runtime tampering", () => {
    const plan = compileExperimentPlanV2({
      request,
      candidate: { candidateId: "cand-1", codeHash: "a".repeat(64), configHash: "b".repeat(64), warmupBars: 24, declaredSearchBudget: 1 },
      runtime: runtime("lean_python"),
      datasets: [dataset("SPY")],
      interval: "1h",
      warmupBars: 24,
      declaredSearchBudget: 1,
      calendarPolicyVersion: "finny-calendars-2026.1",
      qualificationPolicy: policy as any,
      windows,
    })
    expect(verifyExperimentPlanV2({ ...plan, runtime: { ...plan.runtime, leanCommit: "abc" } })).not.toEqual([])
    expect(verifyExperimentPlanV2({ ...plan, orderPolicyVersion: 2 as any })).not.toEqual([])
    expect(verifyExperimentPlanV2({ ...plan, canonicalMetricsVersion: 2 as any })).not.toEqual([])
  })

  test("rejects plans without derived phase windows", () => {
    expect(() =>
      compileExperimentPlanV2({
        request,
        candidate: { candidateId: "cand-1", codeHash: "a".repeat(64), configHash: "b".repeat(64), warmupBars: 24, declaredSearchBudget: 1 },
        runtime: runtime("lean_python"),
        datasets: [dataset("SPY")],
        interval: "1h",
        warmupBars: 24,
        declaredSearchBudget: 1,
        calendarPolicyVersion: "finny-calendars-2026.1",
        qualificationPolicy: policy as any,
      }),
    ).toThrow(/phase windows must be derived/)
  })

  test("verification rejects empty phase windows", () => {
    const plan = compileExperimentPlanV2({
      request,
      candidate: { candidateId: "cand-1", codeHash: "a".repeat(64), configHash: "b".repeat(64), warmupBars: 24, declaredSearchBudget: 1 },
      runtime: runtime("lean_python"),
      datasets: [dataset("SPY")],
      interval: "1h",
      warmupBars: 24,
      declaredSearchBudget: 1,
      calendarPolicyVersion: "finny-calendars-2026.1",
      qualificationPolicy: policy as any,
      windows,
    })
    expect(
      verifyExperimentPlanV2({
        ...plan,
        windows: { ...plan.windows, confirmatory: { start: "", end: "", bars: 0, sessions: 0, firstSessionId: "", lastSessionId: "" } },
      }),
    ).not.toEqual([])
  })
})

describe("LEAN data bundle materialization", () => {
  test("is deterministic and phase-scoped", async () => {
    const schedules = [
      {
        symbol: "SPY",
        assetClass: "equity" as const,
        interval: "1h",
        calendarId: "XNYS",
        calendarVersion: "finny-calendars-2026.1",
        timezone: "America/New_York",
        scheduleHash: "s".repeat(64),
        bars: Array.from({ length: 100 }, (_, i) => ({
          timestamp: new Date(Date.UTC(2026, 0, 1 + Math.floor(i / 6), 14 + (i % 6))).toISOString(),
          sessionId: `2026-01-${String(1 + Math.floor(i / 6)).padStart(2, "0")}`,
        })),
      },
    ]
    const a = await materializeLeanDataBundle({
      phase: "exploratory",
      interval: "1h",
      assetFamily: "equity",
      schedules,
      window: { start: "2026-01-02", end: "2026-01-05" },
      warmupBars: 24,
      outputDir: `/tmp/finny-lean-bundle-test-${Math.random().toString(36).slice(2)}`,
    })
    const b = await materializeLeanDataBundle({
      phase: "exploratory",
      interval: "1h",
      assetFamily: "equity",
      schedules,
      window: { start: "2026-01-02", end: "2026-01-05" },
      warmupBars: 24,
      outputDir: `/tmp/finny-lean-bundle-test-${Math.random().toString(36).slice(2)}`,
    })
    expect(a.bundleHash).toBe(b.bundleHash)
    expect(a.symbols[0]?.rows).toBeGreaterThan(0)
    expect(a.symbols[0]?.rows).toBeLessThan(schedules[0].bars.length)
    expect(a.fillForward).toBe(false)
    expect(a.normalizationMode).toBe("raw")
  })

  test("rejects negative warmup bars instead of silently ignoring them", async () => {
    await expect(
      materializeLeanDataBundle({
        phase: "exploratory",
        interval: "1h",
        assetFamily: "equity",
        schedules: [
          {
            symbol: "SPY",
            assetClass: "equity" as const,
            interval: "1h",
            calendarId: "XNYS",
            calendarVersion: "finny-calendars-2026.1",
            timezone: "America/New_York",
            scheduleHash: "s".repeat(64),
            bars: [{ timestamp: "2026-01-02T14:30:00.000Z", sessionId: "2026-01-02" }],
          },
        ],
        window: { start: "2026-01-02", end: "2026-01-02" },
        warmupBars: -3,
        outputDir: `/tmp/finny-lean-bundle-test-${Math.random().toString(36).slice(2)}`,
      }),
    ).rejects.toThrow(/warmupBars must be a non-negative integer/)
  })
})

describe("runtime config embedding", () => {
  test("round-trips a LEAN runtime into config JSON", () => {
    const config = embedRuntimeConfig({
      config: '{"symbol":"SPY","interval":"1h"}',
      profileId: "lean_python",
      sourceFiles: [{ path: "main.py", sha256: "a".repeat(64), bytes: 12 }],
    })
    const parsed = JSON.parse(config)
    expect(parsed.runtime.profile.profileId).toBe("lean_python")
    expect(parsed.runtime.source.files[0].path).toBe("main.py")
    expect(runtimeFromConfig(config).profile.profileId).toBe("lean_python")
  })
})

describe("canonical result mapping", () => {
  test("maps engine_v2 blobs into CrucibleResultV1", () => {
    const v2: EngineV2.Results = {
      schema_version: "3.5.0",
      engine_version: "engine_v2",
      seed: 1,
      starting_equity: 10000,
      ending_equity: 10500,
      bars_processed: 1000,
      interval: "1h",
      start_ts: "2026-01-01T00:00:00Z",
      end_ts: "2026-06-30T00:00:00Z",
      symbols: ["SPY"],
      total_return: 0.05,
      max_drawdown: -0.02,
      ann_vol: 0.1,
      ann_sharpe: 1.2,
      total_trades: 10,
      win_rate: 0.5,
      profit_factor: 1.5,
      trades: [
        {
          symbol: "SPY",
          side: "long",
          entry_ts: "2026-01-02T00:00:00Z",
          exit_ts: "2026-01-03T00:00:00Z",
          qty: 10,
          entry_price: 100,
          exit_price: 101,
          pnl: 10,
          pnl_pct: 0.01,
          r_multiple: 1,
          fees: 0.5,
          funding: 0,
          borrow: 0,
          mae: -0.5,
          mfe: 1.5,
          hold_bars: 6,
          entry_tag: "",
          exit_tag: "",
          liquidation: false,
        },
      ],
      open_trades: [],
      per_symbol: [],
      data_quality: {
        n_bars: 1000,
        coverage_pct: 1,
        gap_count: 0,
        duplicate_ts_count: 0,
        ohlc_violations: 0,
        outlier_bars: 0,
        zero_volume_bars: 0,
        notes: [],
      },
      returns: {} as any,
      risk: {} as any,
      ratios: {} as any,
      drawdown: {} as any,
      trade: {} as any,
      exposure: {} as any,
      stability: {} as any,
    }
    const canonical = crucibleResultFromEngineV2(v2)
    expect(canonical.runtimeProfileId).toBe("finny_python")
    expect(canonical.totalReturn).toBe(0.05)
    expect(canonical.totalTrades).toBe(10)
    expect(canonical.fills).toHaveLength(1)
    expect(canonical.runKind).toBe("crucible_2_0")
  })
})

describe("LEAN summary statistic parsing", () => {
  function artifactsWithStatistics(statistics: Record<string, unknown>) {
    return {
      schema: "finny.lean_run_artifacts" as const,
      version: 1 as const,
      orders: [],
      fills: [],
      rejections: [],
      equityCurve: [],
      rawStatistics: statistics,
      leanResultPath: "",
      leanSummaryPath: "",
    }
  }

  test("parses LEAN percent and currency statistic strings into Finny units", () => {
    // StatisticsBuilder formats percentages as "-38.303%" and fees as
    // "$220.00"; ratios/counts stay bare decimals.
    const canonical = canonicalizeLeanArtifacts({
      artifacts: artifactsWithStatistics({
        "Net Profit": "-38.303%",
        "Drawdown": "38.410%",
        "Total Fees": "$220.00",
        "End Equity": "6169.65",
        "Start Equity": "10000.00",
        "Total Orders": "6",
        "Win Rate": "43%",
        "Profit-Loss Ratio": "1.24",
        "Sharpe Ratio": "0.512",
        "Annual Standard Deviation": "0.184",
      }),
      startingEquity: 10000,
      engineVersion: "lean-c6cc3b74",
      runtimeProfileId: "lean_python",
    })
    expect(canonical.totalReturn).toBeCloseTo(-0.38303, 8)
    expect(canonical.maxDrawdown).toBeCloseTo(0.3841, 8)
    expect(canonical.fees).toBeCloseTo(220, 8)
    expect(canonical.endingEquity).toBeCloseTo(6169.65, 8)
    expect(canonical.totalTrades).toBe(6)
    expect(canonical.winRate).toBeCloseTo(0.43, 8)
    expect(canonical.profitFactor).toBeCloseTo(1.24, 8)
    expect(canonical.sharpeRatio).toBeCloseTo(0.512, 8)
    expect(canonical.annualizedVolatility).toBeCloseTo(0.184, 8)
  })

  test("keeps a zero final equity instead of falling back to starting equity", () => {
    const canonical = canonicalizeLeanArtifacts({
      artifacts: artifactsWithStatistics({
        "Net Profit": "-100.00%",
        "Drawdown": "100.00%",
        "End Equity": "0.00",
        "Total Orders": "4",
        "Total Fees": "$20.00",
      }),
      startingEquity: 10000,
      engineVersion: "lean-c6cc3b74",
      runtimeProfileId: "lean_python",
    })
    expect(canonical.endingEquity).toBe(0)
    expect(canonical.totalReturn).toBeCloseTo(-1, 8)
    expect(canonical.maxDrawdown).toBeCloseTo(1, 8)
  })
})
