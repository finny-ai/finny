import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  gradeTrajectory,
  isSuiteContract,
  validateSuite,
  type ScenarioContract,
  type SuiteContract,
  type Trajectory,
} from "../../src/finnybench/trajectory-grader"
import { baselineDifferences, coverageErrors } from "../../script/finnybench-trajectory"

const suitePath = join(import.meta.dir, "../../finnybench/trajectory-suite.json")
const suiteValue: unknown = JSON.parse(await readFile(suitePath, "utf8"))
if (!isSuiteContract(suiteValue)) throw new Error("test suite fixture is invalid")
const suite: SuiteContract = suiteValue
const promptSha = (scenario: ScenarioContract) => scenario.prompt_sha256
const providerSha = (provider: string) => suite.providers.find((item) => item.id === provider)!.config_sha256

function basePins(scenario: ScenarioContract, provider: string): Trajectory["pins"] {
  return {
    prompt_sha256: promptSha(scenario),
    model: provider === "gemini-3.1-pro" ? "google/gemini-3.1-pro-preview" : "openai-compatible/frontier",
    provider,
    provider_config_sha256: providerSha(provider),
    data_snapshot_sha256: "1".repeat(64),
    harness_revision: "2".repeat(40),
  }
}

function baseUsage(scenario: ScenarioContract): Trajectory["usage"] {
  return {
    input_tokens: 100,
    cached_input_tokens: 20,
    reasoning_tokens: 10,
    output_tokens: 20,
    latency_ms: Math.min(10_000, scenario.budgets.latency_ms),
    estimated_cost_usd: Math.min(0.001, scenario.budgets.estimated_cost_usd),
  }
}

function baseTrajectory(scenario: ScenarioContract, provider: string): Trajectory {
  return {
    schema: "finnybench.trajectory.v1",
    scenario_id: scenario.id,
    run_id: `run-${scenario.id}-${provider}`,
    pins: basePins(scenario, provider),
    terminal: { class: scenario.expected_terminal, summary: "deterministic fixture" },
    identity: [
      { source: "request_spec", symbol: "AAPL", interval: "1d", asset_class: "equity", algorithm_name: "aapl-sma" },
    ],
    evidence: [
      {
        kind: "market_data",
        status: "OK",
        provenance: ["fixture://bars"],
        published_at: "2026-01-01T00:00:00Z",
        retrieved_at: "2026-01-02T00:00:00Z",
      },
    ],
    tool_calls: [{ name: "finny_workspace_prepare", status: "completed", repeated_task_key: "prepare" }],
    children: [{ id: "data_agent-1", status: "completed", tokens: 10 }],
    usage: baseUsage(scenario),
    traces: [
      { trace_id: "trace-1", span_id: "root", name: "user-turn", payload: "redacted" },
      { trace_id: "trace-1", span_id: "child", parent_span_id: "root", name: "model" },
    ],
    strategy_quality: {
      valid_backtest: true,
      leakage_test: true,
      signals_lagged: true,
      decision_execution_separated: true,
      robustness_checks: ["sample_sufficiency", "walk_forward", "lookahead", "execution_realism"],
      annualization_periods: 252,
      packaging_valid: true,
    },
    security: {
      canary: "FINNYBENCH_CANARY",
      allowlisted_fields: ["provider_request.authorization"],
      observed: [{ field: "provider_request.authorization", value: "FINNYBENCH_CANARY" }],
    },
    control_file: { before_sha256: "3".repeat(64), after_sha256: "3".repeat(64) },
    discovery: { advertised_provider_resolved: true, host_path_probes: 0 },
    storage: {
      session_database: "finny.db",
      lifecycle_databases: ["finny.db", "finny.db"],
      lifecycle_joinable: true,
    },
    experiment: { expected_trials: 4, ledger_increment: 4, holdout_peek_rejected: true },
    artifacts: [
      { path: "algo", kind: "scaffold", valid: true },
      { path: "algo.py", kind: "save", valid: true },
      { path: "run", kind: "strict_backtest", valid: true },
      { path: "manifest.json", kind: "data_manifest", valid: true, metadata: { output_path: "bars.csv" } },
    ],
    route: { requested_agent: "finny-build", resolved_agent: "finny-build" },
  }
}

const scenarioOverrides: Record<string, (trajectory: Trajectory) => void> = {
  "unavailable-intraday-evidence": (trajectory) => {
    trajectory.identity = [{ source: "request_spec", symbol: "SPY", interval: "15m", asset_class: "equity" }]
    trajectory.evidence = [{ kind: "market_data", status: "unavailable" }]
    trajectory.strategy_quality = undefined
  },
  "source-outage": (trajectory) => {
    trajectory.evidence = [{ kind: "news", status: "NO_SOURCED_CONTEXT" }]
    trajectory.strategy_quality = undefined
  },
  "clarification-only-research": (trajectory) => {
    trajectory.tool_calls = [{ name: "question", status: "completed" }]
    trajectory.children = []
    trajectory.strategy_quality = undefined
  },
  "provider-failure": (trajectory) => {
    trajectory.tool_calls = []
    trajectory.children = []
    trajectory.strategy_quality = undefined
  },
  "child-cancellation": (trajectory) => {
    trajectory.children = [{ id: "data_agent-1", status: "cancelled", tokens: 1 }]
    trajectory.strategy_quality = undefined
  },
  "one-mandatory-worker": (trajectory) => {
    trajectory.strategy_quality = undefined
  },
  "calendar-annualization-equity-minute": (trajectory) => {
    trajectory.strategy_quality!.annualization_periods = 98_280
  },
  "calendar-annualization-crypto-minute": (trajectory) => {
    trajectory.strategy_quality!.annualization_periods = 525_600
  },
  "agent-typo": (trajectory) => {
    trajectory.route = { requested_agent: "finny-build", resolved_agent: "finny-build" }
    trajectory.strategy_quality = undefined
  },
}

function passingTrajectory(scenario: ScenarioContract, provider = "gemini-3.1-pro"): Trajectory {
  const trajectory = baseTrajectory(scenario, provider)
  scenarioOverrides[scenario.id]?.(trajectory)
  return trajectory
}

describe("FinnyBench trajectory suite", () => {
  test("has valid public contracts for both required provider families", () => {
    expect(validateSuite(suite)).toEqual([])
    expect(suite.providers.map((provider) => provider.family).sort()).toEqual(["gemini", "openai-compatible"])
    expect(suite.scenarios.some((scenario) => scenario.subset === "smoke")).toBe(true)
    expect(suite.scenarios.some((scenario) => scenario.subset === "full")).toBe(true)
  })

  test("grades every initial and audit trajectory deterministically on both provider profiles", () => {
    expect(suite.scenarios).toHaveLength(22)
    for (const scenario of suite.scenarios) {
      for (const provider of suite.providers) {
        const grade = gradeTrajectory(suite, passingTrajectory(scenario, provider.id))
        expect(grade.pass, `${scenario.id} on ${provider.id}`).toBe(true)
        expect(grade.failure_origin).toBe(
          scenario.expected_terminal === "blocked_provider"
            ? "provider"
            : scenario.expected_terminal === "blocked_unavailable_evidence"
              ? "evidence"
              : scenario.expected_terminal === "blocked_harness"
                ? "harness"
                : "none",
        )
      }
    }
  })

  test("requires full provider-backed coverage for every epic scenario", () => {
    const grades = suite.scenarios.flatMap((scenario) =>
      suite.providers.map((provider) => gradeTrajectory(suite, passingTrajectory(scenario, provider.id))),
    )
    expect(coverageErrors(suite, grades, "full")).toEqual([])
    expect(coverageErrors(suite, grades.slice(1), "full")).toEqual([
      `${grades[0].scenario_id}:${grades[0].provider}: missing provider-backed trajectory`,
    ])
  })

  test("keeps terminal classification separate from strategy quality", () => {
    const scenario = suite.scenarios.find((item) => item.id === "leakage-challenge")!
    const trajectory = passingTrajectory(scenario)
    trajectory.strategy_quality!.leakage_test = false
    const grade = gradeTrajectory(suite, trajectory)
    expect(grade.terminal_pass).toBe(true)
    expect(grade.harness_invariants_pass).toBe(true)
    expect(grade.strategy_quality_pass).toBe(false)
    expect(grade.pass).toBe(false)
  })

  test("distinguishes provider, evidence, harness, and model terminal failures", () => {
    const cases = [
      ["provider-failure", "provider"],
      ["source-outage", "evidence"],
      ["agent-typo", "harness"],
    ] as const
    for (const [scenarioId, origin] of cases) {
      const scenario = suite.scenarios.find((item) => item.id === scenarioId)!
      expect(gradeTrajectory(suite, passingTrajectory(scenario)).failure_origin).toBe(origin)
    }
    const scenario = { ...suite.scenarios[0], expected_terminal: "failed_model" as const }
    expect(gradeTrajectory({ ...suite, scenarios: [scenario] }, passingTrajectory(scenario)).failure_origin).toBe(
      "model",
    )
  })

  test("rejects identity drift, secret leakage, orphan children, and broken trace topology", () => {
    const checks = [
      [
        "identity-indicator-horizon",
        (item: Trajectory) => item.identity.push({ ...item.identity[0], interval: "20d" }),
      ],
      [
        "secret-canary",
        (item: Trajectory) => item.security!.observed.push({ field: "tool.output", value: item.security!.canary }),
      ],
      ["child-cancellation", (item: Trajectory) => item.children.push({ id: "orphan", status: "running", tokens: 0 })],
      [
        "trace-tree",
        (item: Trajectory) => item.traces.push({ trace_id: "trace-2", span_id: "orphan", name: "orphan" }),
      ],
    ] as const
    for (const [scenarioId, breakInvariant] of checks) {
      const scenario = suite.scenarios.find((item) => item.id === scenarioId)!
      const trajectory = passingTrajectory(scenario)
      breakInvariant(trajectory)
      expect(gradeTrajectory(suite, trajectory).pass, scenarioId).toBe(false)
    }
  })

  test("requires exact reproducibility pins and explicit baseline review", () => {
    const scenario = suite.scenarios[0]
    const trajectory = passingTrajectory(scenario)
    trajectory.pins.harness_revision = "dev"
    const grade = gradeTrajectory(suite, trajectory)
    expect(grade.reproducible).toBe(false)

    const current = gradeTrajectory(suite, passingTrajectory(scenario))
    const accepted = {
      schema: "finnybench.trajectory-baseline.v1" as const,
      grades: [
        {
          scenario_id: current.scenario_id,
          provider: current.provider,
          model: current.model,
          pass: current.pass,
          terminal_pass: current.terminal_pass,
          harness_invariants_pass: current.harness_invariants_pass,
          strategy_quality_pass: current.strategy_quality_pass,
          budget_pass: current.budget_pass,
        },
      ],
    }
    expect(baselineDifferences(accepted, [current])).toEqual([])
    expect(baselineDifferences(accepted, [{ ...current, budget_pass: false, pass: false }])).toEqual([
      `${current.scenario_id}:${current.provider}:${current.model}: score changed and requires baseline review`,
    ])
  })
})
