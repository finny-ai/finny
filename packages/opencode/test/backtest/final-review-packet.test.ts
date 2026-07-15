import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extractCoreMetrics, normalizeMetricsDocument, renderQuantReviewHtml, validateTerminalReview, writeFileAtomically, type QuantReviewData } from "../../src/backtest/final-review-packet"

const data: QuantReviewData = {
  algorithm: { algorithmId: "algo-1", name: "spy-alpha", version: 2 } as any,
  versions: [
    { algorithmId: "algo-1", name: "spy-alpha", version: 1, code: "class Strategy: pass", reasoning: "baseline" },
    { algorithmId: "algo-1", name: "spy-alpha", version: 2, code: "class Strategy: pass # revised", reasoning: "revised exit" },
  ] as any,
  specs: [{ experimentId: "exp-12345678", hypothesis: "momentum persists", falsificationCriteria: "negative OOS alpha", universe: ["SPY"], interval: "1h", benchmark: "SPY", costs: "5 bps", executionSemantics: "next open", permittedSearchSpace: "lookback 10-30", optimizationBudget: 5, riskConstraints: "10% max drawdown", specHash: "abc" } as any],
  events: [{ event: "completed", experimentId: "exp-12345678", algorithmId: "algo-1", algorithmVersion: 2, timestamp: "2026-01-01", trialId: "trial-2", runId: "run-2", codeHash: "code-2", configHash: "config-2", actualDataHash: "data-2" } as any],
  runs: [{
    manifest: { id: "run-2", algorithmName: "spy-alpha", algorithmVersion: 2, results: { totalReturn: .12, sharpeRatio: 1.3, maxDrawdown: .08, totalTrades: 40, winRate: .55, profitFactor: 1.4 }, alpha: .03 } as any,
    verdict: "recommended_for_paper", reasons: ["OOS gates passed"], equity: [100, 104, 112], equityLabels: ["2026-01-01", "2026-02-01", "2026-03-01"], benchmark: [100, 102, 106], rollingSharpe: [.4, .8, 1.3], monthlyReturns: { "2026": { "01": .01 } }, foldSharpes: [.7, 1.1], warnings: [], robustness: { stitched_oos_return: .06 }, decay: { label: "stable", confidence: "high", mann_kendall: { trend: "no_trend" }, fold_slope: { slope: .2 } }, consistency: { label: "consistent", confidence: "high" }, identity: { identityHash: "immutable-1", engine: { version: "2" } }, metrics: { totalReturn: .12, alpha: .03, sharpe: 1.3, sortino: 1.7, calmar: 1.5, maxDrawdown: .08, annualizedVolatility: .14, profitFactor: 1.4, winRate: .55, trades: 40, expectancy: 12, cagr: .2 },
  }],
  experimentId: "exp-12345678",
  conclusion: "recommended_for_paper",
  conclusionReason: "All terminal gates passed.",
  generatedAt: "2026-07-12T00:00:00Z",
}

function failedTrialFixture(count = 5) {
  const completed = Array.from({ length: count }, (_, index) => ({
    ...data.events[0],
    trialId: `trial-${index}`,
    runId: `run-${index}`,
    outcome: "failed" as const,
  }))
  const started = completed.map((event) => ({
    ...event,
    event: "started" as const,
    runId: undefined,
    outcome: undefined,
  }))
  const runs = completed.map((event) => ({
    ...data.runs[0],
    manifest: { ...data.runs[0].manifest, id: event.runId! },
    verdict: "failed",
  }))
  return { completed, started, runs }
}

function exhaustionInput(fixture = failedTrialFixture()) {
  return {
    algorithmId: "algo-1",
    experimentId: data.experimentId,
    specs: [{ ...data.specs[0], optimizationBudget: 5 }],
    events: [...fixture.started, ...fixture.completed],
    runs: fixture.runs,
  }
}

describe("final quant review packet", () => {
  test("renders a self-contained lineage packet with quant evidence and explicit approval boundary", () => {
    const html = renderQuantReviewHtml(data)
    expect(html).toContain("Final quant review")
    expect(html).toContain("Audit trail")
    expect(html).toContain("Performance evidence")
    expect(html).toContain("Human review is required before finny_paper_approve")
    expect(html).toContain("exp-12345678")
    expect(html).toContain("Alpha decay · OOS Sharpe by fold")
    expect(html).toContain("codeHash=code-2")
    expect(html).toContain("configHash=config-2")
    expect(html).toContain("dataHash=data-2")
    expect(html).toContain("immutable-1")
    expect(html).toContain("Monthly returns")
    expect(html).toContain("color-scheme:light")
    expect(html).toContain("background:var(--paper)")
    expect(html.indexOf("Backtest metrics")).toBeLessThan(html.indexOf("Mandate"))
    for (const label of ["Total return", "Alpha", "Sharpe", "Sortino", "Calmar", "Max drawdown", "Ann. volatility", "Profit factor", "Win rate", "Trades", "Expectancy", "CAGR"]) expect(html).toContain(label)
    for (const target of ["backtest-detail", "walk-detail", "decay-detail"]) {
      expect(html).toContain(`popovertarget="${target}"`)
      expect(html).toContain(`popover id="${target}"`)
    }
    expect(html).toContain("2026-01-01")
    expect(html).toContain("Fold 1")
    expect(html).toContain("baseline")
    expect(html).toMatch(/<details><summary>v1/)
    expect(html).not.toMatch(/<details open><summary>v1/)
    expect((html.match(/<svg/g) ?? []).length).toBe(3)
    expect(html).not.toContain("<script")
  })

  test("escapes saved strategy content", () => {
    const html = renderQuantReviewHtml({ ...data, versions: [{ ...data.versions[0], code: "<script>alert(1)</script>" }] })
    expect(html).not.toContain("<script>alert")
    expect(html).toContain("&lt;script&gt;")
  })

  test("renders a labeled compact single-point chart", () => {
    const one = { ...data.runs[0], equity: [101], equityLabels: ["2026-04-01"], benchmark: [], foldSharpes: [] }
    const html = renderQuantReviewHtml({ ...data, runs: [one] })
    expect(html).toContain("2026-04-01")
    expect(html).toContain("<circle")
    expect(html).not.toContain("No meaningful series available")
  })

  test("preserves every participating run in comparison and version audit", () => {
    const earlier = { ...data.runs[0], manifest: { ...data.runs[0].manifest, id: "run-v1", algorithmVersion: 1 }, verdict: "failed", reasons: ["v1 cost gate failed"], metrics: { ...data.runs[0].metrics, totalReturn: -.041, alpha: -.073, sharpe: -.45, sortino: -.31, calmar: -.2, maxDrawdown: .19, profitFactor: .72, winRate: .38, trades: 18 } }
    const latest = { ...data.runs[0], manifest: { ...data.runs[0].manifest, id: "run-v2", algorithmVersion: 2 }, verdict: "candidate", reasons: ["v2 OOS sample remains small"] }
    const html = renderQuantReviewHtml({ ...data, runs: [earlier, latest] })
    for (const value of ["run-v1", "run-v2", "-4.10%", "-7.30%", "-0.45", "0.72", "38.00%", "18.0", "v1 cost gate failed", "v2 OOS sample remains small"]) expect(html).toContain(value)
    expect((html.match(/run-v1/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect((html.match(/run-v2/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html).not.toMatch(/<details open><summary>v1/)
  })

  test("normalizes realistic nested v2 metrics without false N/A", () => {
    const nested = { v2: { trade: { expectancy: 14.25, profit_factor: 1.82, total_trades: 31 }, returns: { cagr: .224 }, ratios: { sortino: 1.91, calmar: 1.44, omega: 1.27 }, risk: { ann_vol: .18 }, exposure: { time_in_market_pct: .64, total_turnover: 8.5, avg_gross_exposure: .72, avg_net_exposure: .48 } } }
    expect(normalizeMetricsDocument(nested)).toBe(nested.v2)
    const metrics = extractCoreMetrics(data.runs[0].manifest, nested)
    expect(metrics).toMatchObject({ expectancy: 14.25, profitFactor: 1.82, trades: 31, cagr: .224, sortino: 1.91, calmar: 1.44, omega: 1.27, annualizedVolatility: .18, timeInMarket: .64, turnover: 8.5, avgGrossExposure: .72, avgNetExposure: .48 })
    const html = renderQuantReviewHtml({ ...data, runs: [{ ...data.runs[0], metrics }] })
    for (const value of ["Omega", "1.27", "Time in market", "64.00%", "Turnover", "8.5", "Avg gross exposure", "72.00%", "Avg net exposure", "48.00%", "14.3", "22.40%", "1.91", "1.44"]) expect(html).toContain(value)
  })

  test("fails closed for missing, empty, unrelated, or mismatched terminal evidence", () => {
    const base = { algorithmId: "algo-1", experimentId: data.experimentId, conclusion: "recommended_for_paper" as const, specs: data.specs, events: data.events, runs: data.runs }
    expect(validateTerminalReview({ ...base, specs: [] })).toContain("selected experiment spec is missing")
    expect(validateTerminalReview({ ...base, events: [] })).toContain("experiment lineage has no trial evidence for the selected algorithm")
    expect(validateTerminalReview({ ...base, events: data.events.map((event) => ({ ...event, algorithmId: "other" })) })).toContain("experiment lineage has no trial evidence for the selected algorithm")
    expect(validateTerminalReview({ ...base, runs: data.runs.map((run) => ({ ...run, verdict: "failed" })) })).toContain("recommended_for_paper requires a matching persisted recommended run")
  })

  test("refuses review unless a terminal run beats buy-and-hold", () => {
    const base = { algorithmId: "algo-1", experimentId: data.experimentId, specs: data.specs, events: data.events, conclusion: "recommended_for_paper" as const }
    const tied = data.runs.map((run) => ({ ...run, manifest: { ...run.manifest, alpha: 0 }, metrics: { ...run.metrics, alpha: 0 } }))
    expect(validateTerminalReview({ ...base, runs: tied })).toContain("final review is produced only when the strategy beats buy-and-hold (terminal alpha must be > 0)")
    const missing = data.runs.map((run) => ({ ...run, manifest: { ...run.manifest, alpha: null }, metrics: { ...run.metrics, alpha: null } }))
    expect(validateTerminalReview({ ...base, runs: missing })).toContain("final review requires a persisted terminal run with a buy-and-hold alpha comparison")
    const earlierEvent = { ...data.events[0], timestamp: "2025-12-31", trialId: "trial-1", runId: "run-1" }
    const earlierWinner = { ...data.runs[0], manifest: { ...data.runs[0].manifest, id: "run-1", alpha: 0.2 } }
    expect(validateTerminalReview({ ...base, events: [earlierEvent, ...data.events], runs: [earlierWinner, ...tied] })).toContain("final review is produced only when the strategy beats buy-and-hold (terminal alpha must be > 0)")
  })

  test("refuses review until both terminal backtest and walk-forward returns are positive", () => {
    const base = { algorithmId: "algo-1", experimentId: data.experimentId, specs: data.specs, events: data.events, conclusion: "recommended_for_paper" as const }
    const losingBacktest = data.runs.map((run) => ({ ...run, manifest: { ...run.manifest, results: { ...run.manifest.results, totalReturn: -.01 } } }))
    expect(validateTerminalReview({ ...base, runs: losingBacktest })).toContain("final review is produced only when the terminal backtest return is > 0")
    const losingWalkForward = data.runs.map((run) => ({ ...run, robustness: { ...run.robustness, stitched_oos_return: -.01 } }))
    expect(validateTerminalReview({ ...base, runs: losingWalkForward })).toContain("final review is produced only when the stitched walk-forward OOS return is > 0")
    const missingWalkForward = data.runs.map((run) => ({ ...run, robustness: undefined }))
    expect(validateTerminalReview({ ...base, runs: missingWalkForward })).toContain("final review requires a persisted stitched walk-forward OOS return")
  })

  test("allows benchmark-beating research to complete without paper recommendation", () => {
    const researchRun = {
      ...data.runs[0],
      verdict: "failed",
      reasons: ["quality gates failed"],
    }
    const input = {
      algorithmId: "algo-1",
      experimentId: data.experimentId,
      specs: data.specs,
      events: [{ ...data.events[0], outcome: "failed" as const }],
      runs: [researchRun],
      conclusion: "research_complete" as const,
    }
    expect(validateTerminalReview(input)).toEqual([])
    expect(validateTerminalReview({ ...input, conclusion: "recommended_for_paper" })).toContain("recommended_for_paper requires a matching persisted recommended run")
    expect(validateTerminalReview({ ...input, runs: data.runs })).toContain("research_complete cannot replace a recommended_for_paper conclusion")
    expect(renderQuantReviewHtml({ ...data, conclusion: "research_complete" })).toContain("Research completed with benchmark outperformance")
  })

  test("validates concept exhaustion against persisted failed trials", () => {
    const fixture = failedTrialFixture()
    const common = exhaustionInput(fixture)
    expect(validateTerminalReview({ ...common, conclusion: "concept_exhausted" })).toEqual([])
    const short = failedTrialFixture(4)
    expect(validateTerminalReview({ ...exhaustionInput(short), conclusion: "concept_exhausted" })[0]).toContain("5 consecutive completed failed")
    const passed = fixture.completed.map((event) => ({ ...event, outcome: "passed" as const }))
    expect(validateTerminalReview({ ...common, events: [...fixture.started, ...passed], conclusion: "concept_exhausted" })[0]).toContain("5 consecutive completed failed")
  })

  test("validates optimization exhaustion against started-trial budget", () => {
    const fixture = failedTrialFixture()
    const common = exhaustionInput(fixture)
    expect(validateTerminalReview({ ...common, conclusion: "optimization_exhausted" })).toEqual([])
    expect(validateTerminalReview({ ...common, events: fixture.completed, conclusion: "optimization_exhausted" })[0]).toContain("uniquely started")
  })

  test("concept exhaustion requires a consecutive persisted failure streak", () => {
    const outcomes = ["failed", "failed", "passed", "failed", "failed", "failed"] as const
    const completed = outcomes.map((outcome, index) => ({ ...data.events[0], trialId: `streak-${index}`, runId: `streak-run-${index}`, outcome }))
    const runs = completed.map((event) => ({ ...data.runs[0], manifest: { ...data.runs[0].manifest, id: event.runId! }, verdict: event.outcome }))
    const base = { algorithmId: "algo-1", experimentId: data.experimentId, specs: data.specs, events: completed, runs, conclusion: "concept_exhausted" as const }
    expect(validateTerminalReview(base)[0]).toContain("current streak 3")
    expect(validateTerminalReview({ ...base, events: completed.slice(0, 5).map((event) => ({ ...event, outcome: "failed" as const })), runs: [] }).join("; ")).toContain("current streak 0")
  })

  test("requires blocked outcome semantics and a complete ancestor chain", () => {
    const blocked = { ...data.events[0], outcome: "blocked" as const, runId: undefined }
    const base = { algorithmId: "algo-1", experimentId: data.experimentId, specs: data.specs, events: [blocked], runs: [] }
    expect(validateTerminalReview({ ...base, conclusion: "blocked" })).toContain("final review requires a persisted terminal run with a buy-and-hold alpha comparison")
    const failedNoRun = { ...blocked, outcome: "failed" as const }
    expect(validateTerminalReview({ ...base, events: [failedNoRun], conclusion: "blocked" })).toContain("final review requires a persisted terminal run with a buy-and-hold alpha comparison")
    const failedStrategyRun = { ...failedNoRun, runId: "run-2" }
    expect(validateTerminalReview({ ...base, events: [failedStrategyRun], runs: data.runs, conclusion: "blocked" }).join("; ")).toContain("failed no-run hard blocker")
    expect(validateTerminalReview({ ...base, events: [{ ...blocked, outcome: "passed" }], conclusion: "blocked" }).join("; ")).toContain("failed no-run hard blocker")
    const child = { ...data.specs[0], parentExperimentId: "exp-missing-parent" }
    expect(validateTerminalReview({ ...base, specs: [child], conclusion: "blocked" }).join("; ")).toContain("ancestor spec is missing or corrupt")
  })

  test("renders failed no-run trial details without claiming a missing participating trial", () => {
    const failed = { ...data.events[0], runId: undefined, outcome: "failed" as const, details: "validator blocked unsafe lookahead" }
    const html = renderQuantReviewHtml({ ...data, conclusion: "blocked", events: [failed], runs: [], versions: [data.versions[1]] })
    expect(html).toContain("validator blocked unsafe lookahead")
    expect(html).not.toContain("No participating trial for this version")
  })

  test("atomically resolves concurrent same-process packet writes without temp leaks", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finny-review-atomic-"))
    const target = path.join(directory, "review.html")
    const contents = Array.from({ length: 12 }, (_, index) => `packet-${index}`)
    try {
      await Promise.all(contents.map((content) => writeFileAtomically(target, content)))
      expect(contents).toContain(await fs.readFile(target, "utf8"))
      expect((await fs.readdir(directory)).sort()).toEqual(["review.html"])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
