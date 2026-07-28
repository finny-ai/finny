import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Algorithm } from "../../src/algorithm"
import {
  compileAndSaveExperimentPlanV1,
  loadExperimentPlanPolicyV1,
  recordHoldoutOpenEventV1,
} from "../../src/backtest/experiment-plan-store"
import { DurableQualificationAttemptLedgerV1 } from "../../src/backtest/qualification-attempt-ledger"
import { compileInputFromActiveEvidence } from "../../src/backtest/qualification-runtime"
import { DEFAULT_QUALIFICATION_POLICY_V1, qualificationHash } from "../../src/backtest/qualification-policy"
import {
  exportQualificationArtifactV1,
  QualificationArtifactExportError,
} from "../../src/fund/qualification-artifact-export"
import { importQualificationDatasetV1 } from "../../src/fund/qualification-dataset-import"
import { readRequestSpecForSession } from "../../src/agent/request-spec"
import { requireVerifiedDataExtractorEvidenceForSession } from "../../src/data/data-extractor-evidence"

const roots: string[] = []
const originalFinnyHome = process.env.FINNY_HOME

afterEach(async () => {
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function qualifyingResults() {
  return {
    totalReturn: 0.1,
    maxDrawdown: 0.05,
    annualizedVolatility: 0.12,
    sharpeRatio: 1.2,
    endingEquity: 1100,
    totalTrades: 40,
    winRate: 0.55,
    profitFactor: 1.8,
    benchmarkReturn: 0.04,
    benchmarkSharpeRatio: 0.8,
    benchmarkMaxDrawdown: 0.08,
    alpha: 0.06,
    sensitivityOutcomes: [{ name: "Cost/slippage stress", status: "pass", value: 0.02, explanation: "" }],
    diagnostics: {
      barsProcessed: 1000,
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
        flag_threshold: 0.7,
        flagged: false,
        flag_reasons: [],
        deflated_sharpe: 0.99,
        probabilistic_sharpe: 0.99,
        stitched_oos_return: 0.08,
        stitched_oos_sharpe: 1.1,
        stitched_oos_trades: 40,
        stitched_oos_coverage: 1,
        ruined_folds: 0,
        folds: [],
      },
      consistency: {
        label: "consistent",
        confidence: "high",
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
        label: "stable",
        confidence: "high",
        mann_kendall: { trend: "no_trend", s: 0, z: 0, p_value: 1, n: 120 },
        fold_slope: { slope: 0, r_squared: 0, n: 5 },
        breakeven: {
          status: "no_measured_decay",
          months: null,
          slope: 0,
          latest_gross_expectancy: 10,
          per_trade_cost: 1,
          n_months: 6,
          n_trades: 30,
        },
      },
      monte_carlo: { max_dd_p99: -0.2 },
      data_quality: { repair_applied: false },
    },
  } as any
}

describe("qualified artifact export", () => {
  test("exports one exact hash-bound artifact only after all durable phases complete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-qualified-artifact-"))
    roots.push(root)
    process.env.FINNY_HOME = root
    const sessionId = "ses-fund-artifact-export"
    const algorithmName = "btc-fund-artifact"
    const start = Date.parse("2026-01-01T00:00:00.000Z")
    const rows = Array.from({ length: 120 }, (_, index) => {
      const timestamp = new Date(start + index * 86_400_000).toISOString()
      return `${timestamp},100,105,99,104,1000`
    })
    const csv = ["timestamp,open,high,low,close,volume", ...rows].join("\n")
    await importQualificationDatasetV1({
      sessionId,
      algorithmName,
      symbol: "BTC",
      assetClass: "crypto",
      interval: "1d",
      requestedStart: "2026-01-01",
      requestedEnd: "2026-04-30",
      csvBase64: Buffer.from(csv).toString("base64"),
      csvSha256: sha256(csv),
      providerId: "binance",
      providerFeed: "production-usdm-klines",
      providerVenue: "BINANCE",
      providerSymbol: "BTCUSDT",
      priceBasis: "raw",
      splitTreatment: "not_applicable",
      dividendTreatment: "not_applicable",
      corporateActionStatus: "not_applicable",
    })
    const code =
      "class Strategy:\n    def __init__(self, broker, params=None): self.broker = broker\n    def on_bar(self, symbol, bar): return None\n"
    const config = JSON.stringify({
      symbol: "BTC",
      asset_class: "crypto",
      starting_capital: 1000,
      warmup_bars: 2,
      optimization_budget: 20,
    })
    const candidate = await Algorithm.save({
      name: algorithmName,
      code,
      config,
      language: "python",
      saveMode: "new",
    })
    const request = await readRequestSpecForSession({ sessionID: sessionId })
    const evidence = await requireVerifiedDataExtractorEvidenceForSession(sessionId)
    if (!request || !evidence.ok) throw new Error("test qualification inputs are incomplete")
    const plan = await compileAndSaveExperimentPlanV1(
      await compileInputFromActiveEvidence({
        request,
        dataset: evidence.dataset,
        candidate,
        policy: DEFAULT_QUALIFICATION_POLICY_V1,
      }),
    )
    const policy = await loadExperimentPlanPolicyV1(plan.planId)
    await recordHoldoutOpenEventV1({
      plan,
      approvalHash: "c".repeat(64),
    })
    const executionIdentity = {
      codeHash: qualificationHash(candidate.code),
      configHash: qualificationHash(candidate.config ?? ""),
    }
    for (const phase of ["exploratory", "validation", "confirmatory"] as const) {
      const identity = {
        plan,
        candidateId: candidate.algorithmId,
        phase,
        policy,
        executionIdentity,
      }
      const claim = await DurableQualificationAttemptLedgerV1.claim(identity)
      if (claim.kind !== "execute") throw new Error(`unexpected ${phase} ledger state`)
      await DurableQualificationAttemptLedgerV1.complete({
        ...identity,
        attemptId: claim.attemptId,
        result: { ok: true, results: qualifyingResults() },
      })
    }
    const result = await exportQualificationArtifactV1({
      sessionId,
      algorithmId: candidate.algorithmId,
      experimentPlanId: plan.planId,
    })
    expect(result).toMatchObject({
      algorithmId: candidate.algorithmId,
      algorithmVersion: candidate.version,
      code,
      config: candidate.config,
      codeHash: executionIdentity.codeHash,
      configHash: executionIdentity.configHash,
      experimentPlanHash: plan.planHash,
      completedPhases: ["exploratory", "validation", "confirmatory"],
    })
    expect(result.artifactEvidenceHash).toHaveLength(64)
  })

  test("fails closed before reading state for malformed identities", async () => {
    await expect(
      exportQualificationArtifactV1({
        sessionId: "bad",
        algorithmId: "also-bad",
        experimentPlanId: "plan-nope",
      }),
    ).rejects.toBeInstanceOf(QualificationArtifactExportError)
  })
})
