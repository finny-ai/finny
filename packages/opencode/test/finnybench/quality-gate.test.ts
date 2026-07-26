import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  evaluateQualityGate,
  isQualityGateConfig,
  isQualityObservation,
  qualityAggregates,
  qualityReportMarkdown,
  type QualityGateConfig,
  type QualityObservation,
} from "../../src/finnybench/quality-gate"
import { qualityObservationFromTrajectory } from "../../script/finnybench-quality"
import type { Trajectory } from "../../src/finnybench/trajectory-grader"

const fixtureRoot = join(import.meta.dir, "../../finnybench")
const configValue: unknown = JSON.parse(await readFile(join(fixtureRoot, "quality-gate.json"), "utf8"))
if (!isQualityGateConfig(configValue)) throw new Error("quality gate config fixture is invalid")
const config: QualityGateConfig = configValue

async function observations(file: string): Promise<QualityObservation[]> {
  const values: unknown[] = (await readFile(join(fixtureRoot, file), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  if (!values.every(isQualityObservation)) throw new Error(`${file} contains an invalid observation`)
  return values
}

const baseline = await observations("quality-baseline.synthetic.jsonl")
const candidate = await observations("quality-candidate.synthetic.jsonl")

function copy(items: QualityObservation[]): QualityObservation[] {
  return structuredClone(items)
}

describe("FinnyBench quality regression gate", () => {
  test("tracks the four issue #43 aggregates on a deterministic pinned cohort", () => {
    expect(qualityAggregates(baseline)).toEqual({
      observations: 8,
      median_excess_sharpe: 0.2,
      share_beating_buy_hold: 0.625,
      share_exploratory_gate: 0.75,
      median_trade_count: 27,
    })
    const report = evaluateQualityGate({ config, baseline, candidate })
    expect(report.status).toBe("pass")
    expect(report.metrics.map((metric) => metric.metric)).toEqual([
      "median_excess_sharpe",
      "share_beating_buy_hold",
      "share_exploratory_gate",
      "median_trade_count",
    ])
    expect(report.metrics.every((metric) => metric.delta === 0 && metric.status === "pass")).toBe(true)
  })

  test("warns and fails at explicit reviewed regression thresholds", () => {
    const warningCandidate = copy(candidate)
    for (const observation of warningCandidate) observation.strategy.sharpe -= 0.1
    const warning = evaluateQualityGate({ config, baseline, candidate: warningCandidate })
    expect(warning.metrics.find((metric) => metric.metric === "median_excess_sharpe")?.status).toBe("warning")
    expect(warning.status).toBe("warning")

    const failingCandidate = copy(candidate)
    for (const observation of failingCandidate) {
      observation.strategy.sharpe -= 0.26
      observation.strategy.total_return = observation.benchmark.total_return
      observation.strategy.exploratory_gate_passed = false
      observation.strategy.closed_trades = Math.max(0, observation.strategy.closed_trades - 11)
    }
    const failure = evaluateQualityGate({ config, baseline, candidate: failingCandidate })
    expect(failure.status).toBe("failure")
    expect(failure.metrics.every((metric) => metric.status === "failure")).toBe(true)
  })

  test("fails closed when tasks, repetitions, or semantic pins change", () => {
    const changedPins = copy(candidate)
    changedPins[0].pins.data_snapshot_sha256 = "f".repeat(64)
    expect(evaluateQualityGate({ config, baseline, candidate: changedPins }).errors).toEqual([
      "candidate pins changed for synthetic-daily-trend:scripted-a:fixture/v1:0",
    ])

    const missing = candidate.slice(1)
    const missingReport = evaluateQualityGate({ config, baseline, candidate: missing })
    expect(missingReport.status).toBe("failure")
    expect(missingReport.errors).toContain("candidate has 7 observations; requires at least 8")
    expect(missingReport.errors).toContain(
      "candidate is missing pinned cohort synthetic-daily-trend:scripted-a:fixture/v1:0",
    )
  })

  test("requires benchmark evidence to remain non-promotional", () => {
    const invalid = { ...structuredClone(candidate[0]), promotion_eligible: true }
    expect(isQualityObservation(invalid)).toBe(false)

    const markdown = qualityReportMarkdown(evaluateQualityGate({ config, baseline, candidate }))
    expect(markdown).toContain("Benchmark evidence only")
    expect(markdown).toContain("not live alpha evidence, paper eligibility, or deployment approval")

    const mixed = copy(candidate)
    mixed[0].evidence_class = "provider_backed_pinned"
    expect(evaluateQualityGate({ config, baseline, candidate: mixed }).errors).toContain(
      "candidate mixes synthetic and provider-backed evidence",
    )
  })

  test("normalizes quantitative fields from provider-backed trajectory captures", () => {
    const trajectory: Trajectory = {
      schema: "finnybench.trajectory.v1",
      scenario_id: "daily-trend",
      run_id: "run-1",
      pins: {
        prompt_sha256: "1".repeat(64),
        model: "provider/model",
        provider: "provider",
        provider_config_sha256: "2".repeat(64),
        data_snapshot_sha256: "3".repeat(64),
        harness_revision: "4".repeat(40),
      },
      terminal: { class: "success", summary: "complete" },
      identity: [],
      evidence: [],
      tool_calls: [],
      children: [],
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        reasoning_tokens: 0,
        output_tokens: 1,
        latency_ms: 1,
        estimated_cost_usd: 0.01,
      },
      traces: [],
      strategy_quality: {
        valid_backtest: true,
        leakage_test: true,
        signals_lagged: true,
        decision_execution_separated: true,
        robustness_checks: [],
        quality_evidence_class: "provider_backed_pinned",
        repeat: 0,
        strategy_sharpe: 0.8,
        strategy_total_return: 0.1,
        benchmark_sharpe: 0.5,
        benchmark_total_return: 0.07,
        exploratory_gate_passed: true,
        closed_trades: 21,
      },
    }
    expect(qualityObservationFromTrajectory(trajectory)).toMatchObject({
      task_id: "daily-trend",
      evidence_class: "provider_backed_pinned",
      strategy: { sharpe: 0.8, closed_trades: 21 },
      benchmark: { sharpe: 0.5 },
      promotion_eligible: false,
    })
    trajectory.strategy_quality!.strategy_sharpe = Number.NaN
    expect(qualityObservationFromTrajectory(trajectory)).toBeUndefined()
  })

  test("rejects ambiguous thresholds and non-finite metrics", () => {
    const invalidConfig = structuredClone(config)
    invalidConfig.thresholds.median_excess_sharpe.failure_delta = -0.05
    expect(isQualityGateConfig(invalidConfig)).toBe(false)

    const invalidObservation = structuredClone(candidate[0])
    invalidObservation.strategy.sharpe = Number.NaN
    expect(isQualityObservation(invalidObservation)).toBe(false)
  })
})
