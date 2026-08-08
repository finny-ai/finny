import { describe, expect, test } from "bun:test"
import { classifyLiveSignal, collectLiveUsage, inspectLivePreflight } from "../../script/live-harness-signal"
import { RunManifestV1, type HeadlessScenarioV1 } from "../../script/headless/types"

const scenario: HeadlessScenarioV1 = {
  schemaVersion: "1.0.0",
  id: "live",
  prompt: "bounded live signal",
  asOfDate: "2026-07-09",
  limits: { wallTimeMs: 1_200_000, modelTurns: 40, toolCalls: 50, subagents: 4 },
  request: {
    symbols: ["SPY"],
    assetClass: "equity",
    interval: "5m",
    strategyFamilies: ["sma-crossover"],
    startDate: "2026-01-09",
    endDate: "2026-07-08",
  },
  artifactPolicy: { maxAlgorithms: 1, maxVersionsPerAlgorithm: 1, maxBacktests: 1 },
  requiredStages: [],
  requiredFinalFields: [],
  allowedRecoveries: [],
  observabilityRequired: true,
}

function manifest(
  status: "completed" | "contract_failed" | "evidence_invalid" | "execution_failed",
  errors: string[] = [],
) {
  return RunManifestV1.parse({
    schemaVersion: "1.0.0",
    runId: "run",
    scenarioId: "live",
    status,
    exitCode: status === "completed" ? 0 : 1,
    startedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: "2026-07-26T00:00:01.000Z",
    durationMs: 1000,
    source: {
      ref: "HEAD",
      commit: "abc",
      targetTreeHash: "tree",
      treeState: "clean",
      preparation: "test_current_checkout",
      bunLockSha256: "lock",
      evaluatorSourceSha256: "a".repeat(64),
      evaluatorEntrypointSha256: "b".repeat(64),
      scenarioSha256: "c".repeat(64),
    },
    runtime: { os: "test", arch: "test", bunVersion: "test" },
    model: { id: "openai/test", agent: "finny" },
    isolation: {
      namespace: "run",
      reusedState: false,
      finnyHome: "isolated",
      database: "isolated",
      xdgData: "isolated",
      xdgState: "isolated",
      xdgCache: "isolated",
      xdgConfig: "isolated",
      phoenixProject: "run",
      ports: { http: 1 },
      cleanupStatus: "completed",
    },
    attempts: [],
    sessions: { subagents: [] },
    stages: {},
    requestAdherence: { expected: {}, observed: {}, violations: [] },
    strategyResults: [],
    recoveries: [],
    errors: errors.map((message) => ({ kind: "session_error", message })),
    observability: {
      required: true,
      project: "run",
      traceIds: [],
      spanCount: 0,
      unattributedSpanCount: 0,
      paginationComplete: false,
      completionSpanFound: false,
      flush: "not_run",
      grade: "not_run",
    },
    semanticHashes: {
      source: "d".repeat(64),
      normalizedEvents: "e".repeat(64),
      contract: "f".repeat(64),
      strategyResults: "0".repeat(64),
    },
    artifacts: [],
    integrity: { artifactMerkleRoot: "root", checksumAlgorithm: "sha256" },
  })
}

describe("live harness preflight", () => {
  test("accepts an intentionally enabled supported model with credential presence only", () => {
    const result = inspectLivePreflight({
      eventName: "workflow_dispatch",
      enabled: "1",
      model: "openai/test",
      scenario,
      env: {
        OPENAI_API_KEY: "secret-material-one",
        ALPACA_API_KEY_ID: "secret-material-two",
        ALPACA_API_SECRET_KEY: "secret-material-three",
      },
    })
    expect(result.ready).toBe(true)
    expect(result.credentialPresence).toEqual([
      { name: "OPENAI_API_KEY", present: true },
      { name: "ALPACA_API_KEY_ID", present: true },
      { name: "ALPACA_API_SECRET_KEY", present: true },
    ])
    expect(JSON.stringify(result)).not.toContain("secret-material")
  })

  test("reports unsupported provider, missing credentials, disabled state, and limit drift separately", () => {
    const result = inspectLivePreflight({
      eventName: "workflow_dispatch",
      enabled: "",
      model: "other/test",
      scenario: { ...scenario, limits: { ...scenario.limits, toolCalls: 51 } },
      env: {},
    })
    expect(result.ready).toBe(false)
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "live_harness_disabled",
        "model_provider_unsupported",
        "credential_missing",
        "limit_exceeds_ceiling",
      ]),
    )
  })
})

describe("live harness signal classification", () => {
  test("keeps harness, evidence, model-provider, and market-data-provider failures distinct", () => {
    expect(classifyLiveSignal(manifest("completed"))).toBe("success")
    expect(classifyLiveSignal(manifest("contract_failed"))).toBe("harness_contract_failure")
    expect(classifyLiveSignal(manifest("evidence_invalid"))).toBe("evidence_failure")
    expect(classifyLiveSignal(manifest("execution_failed", ["OpenAI quota exceeded"]))).toBe("model_provider_failure")
    expect(classifyLiveSignal(manifest("execution_failed", ["Alpaca historical data unavailable"]))).toBe(
      "market_data_provider_failure",
    )
  })

  test("retains bounded tool, turn, token, subagent, and cost observations", () => {
    const usage = collectLiveUsage(
      [
        { type: "tool_use" },
        {
          type: "step_finish",
          part: {
            cost: 0.0125,
            tokens: { input: 120, output: 30, reasoning: 10, cache: { read: 40, write: 5 } },
          },
        },
        {
          type: "step_finish",
          part: {
            cost: 0.0075,
            tokens: { input: 80, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
          },
        },
      ],
      { ...manifest("completed"), sessions: { main: "main", subagents: [{ id: "child" }] } },
    )
    expect(usage).toEqual({
      modelTurns: 2,
      toolCalls: 1,
      subagents: 1,
      tokens: { input: 200, output: 50, reasoning: 15, cacheRead: 50, cacheWrite: 5 },
      estimatedCostUsd: 0.02,
      costAvailable: true,
    })
  })
})
