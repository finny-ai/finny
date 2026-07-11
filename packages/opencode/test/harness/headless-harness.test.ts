import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { createBundleWriter, publishBundle, writeBundleText } from "../../script/headless/artifacts"
import { runHeadlessHarness } from "../../script/headless/orchestrator"
import { canonicalScenarioJson, scenarioSha256 } from "../../script/headless/scenario"
import { classifyOutcome, observeRun } from "../../script/headless/semantic-verdict"
import type { HeadlessScenarioV1, RunManifestV1 } from "../../script/headless/types"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const scenario: HeadlessScenarioV1 = {
  schemaVersion: "1.0.0",
  id: "fixture",
  prompt: "build",
  asOfDate: "2026-07-09",
  limits: { wallTimeMs: 30_000, modelTurns: 10, toolCalls: 10, subagents: 1 },
  request: {
    symbols: ["SPY"],
    assetClass: "equity",
    interval: "5m",
    strategyFamilies: ["sma-crossover"],
    startDate: "2026-01-09",
    endDate: "2026-07-08",
  },
  artifactPolicy: { maxAlgorithms: 1, maxVersionsPerAlgorithm: 1, maxBacktests: 1 },
  requiredStages: ["candidate_saved", "validated", "backtested", "reviewable"],
  requiredFinalFields: ["return", "sharpe", "max drawdown", "eligibility", "next step"],
  allowedRecoveries: [],
  observabilityRequired: false,
}

function tool(tool: string, input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}) {
  return {
    type: "tool_use",
    sessionID: "ses_main",
    part: { tool, state: { status: "completed", input, output, metadata } },
  }
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    algorithmName: "spy-sma-crossover",
    symbol: "SPY",
    assetClass: "equity",
    interval: "5m",
    startDate: "2026-01-09",
    endDate: "2026-07-08",
    strategyIntent: "sma-crossover",
    ...overrides,
  }
}

function savedConfig(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ symbol: "SPY", asset_class: "equity", interval: "5min", ...overrides })
}

function mission(
  input: {
    family?: string
    symbol?: string
    assetClass?: string
    interval?: string
    startDate?: string
    endDate?: string
  } = {},
) {
  const family = input.family ?? "sma-crossover"
  const symbol = input.symbol ?? "SPY"
  const assetClass = input.assetClass ?? "equities"
  const interval = input.interval ?? "5min"
  const startDate = input.startDate ?? "2026-01-09"
  const endDate = input.endDate ?? "2026-07-08"
  return `---
scope:
  asset_class: ${assetClass}
  universe: [${symbol}]
strategy:
  type: ${family}
  bar_interval: ${interval}
  backtest_window: ${startDate} through ${endDate}
---
candidate
`
}

function backtestInput(overrides: Record<string, unknown> = {}) {
  return {
    algorithmName: "spy-sma-crossover",
    interval: "5min",
    startDate: "2026-01-09",
    endDate: "2026-07-08",
    ...overrides,
  }
}

describe("headless semantic verdict", () => {
  test("same scenario id cannot hide prompt, limit, or required-field mutations", () => {
    const baseline = scenarioSha256(scenario)
    const mutations: HeadlessScenarioV1[] = [
      { ...scenario, prompt: `${scenario.prompt} changed` },
      { ...scenario, limits: { ...scenario.limits, toolCalls: scenario.limits.toolCalls + 1 } },
      { ...scenario, requiredFinalFields: [...scenario.requiredFinalFields, "blockers"] },
    ]
    expect(new Set([baseline, ...mutations.map(scenarioSha256)]).size).toBe(4)
    expect(JSON.parse(canonicalScenarioJson(scenario))).toEqual(scenario)
    expect(mutations.every((mutation) => mutation.id === scenario.id)).toBe(true)
  })

  test("stable harness API is lazy Effect", () => {
    const value = runHeadlessHarness({
      ref: "HEAD",
      scenarioPath: "/not-evaluated",
      model: "test/model",
      agent: "finny",
      outputDir: "/not-evaluated",
    })
    expect(Effect.isEffect(value)).toBe(true)
  })

  test("negative strategy performance is valid completion when the contract is followed", () => {
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "finny_algorithm_save",
        { name: "spy-sma", mission: mission(), config: savedConfig() },
        "Saved and validated",
        { version: 1 },
      ),
      tool(
        "finny_backtest",
        backtestInput({ algorithmName: "spy-sma" }),
        "Total return: -10%\nVerdict: failed\nEligibility: backtested",
      ),
      {
        type: "text",
        sessionID: "ses_main",
        part: { text: "Return -10%; Sharpe -1; max drawdown 12%; eligibility failed; next step: stop." },
      },
    ]
    const observed = observeRun(events, scenario)
    expect(observed.violations).toEqual([])
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({ status: "completed", exitCode: 0 })
  })

  test("strategy drift and a second algorithm fail the contract", () => {
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "finny_algorithm_save",
        { name: "spy-roc", mission: mission({ family: "roc-momentum" }), config: savedConfig() },
        "Saved and validated",
        { version: 1 },
      ),
      tool(
        "finny_algorithm_save",
        { name: "spy-reversion", mission: mission({ family: "mean-reversion" }), config: savedConfig() },
        "Saved and validated",
        { version: 1 },
      ),
      tool(
        "finny_backtest",
        backtestInput({ algorithmName: "spy-roc" }),
        "Verdict: failed\nTotal return: -1%\nEligibility: backtested",
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, scenario)
    expect(observed.violations.map((item) => item.code)).toContain("algorithm_limit")
    expect(observed.violations.map((item) => item.code)).toContain("strategy_family_drift")
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "contract_failed",
      exitCode: 2,
    })
  })

  test("structured symbol, asset class, interval, and date drift cannot hide behind an allowed algorithm name", () => {
    const events = [
      tool(
        "finny_workspace_prepare",
        requestInput({
          symbol: "QQQ",
          assetClass: "crypto",
          interval: "1h",
          startDate: "2026-02-01",
          endDate: "2026-06-01",
        }),
        "Prepared",
      ),
      tool(
        "finny_algorithm_save",
        {
          name: "spy-sma-crossover",
          description: "SPY 5m SMA crossover",
          config: savedConfig({ symbol: "QQQ", asset_class: "crypto", interval: "1h" }),
          mission: mission({
            symbol: "QQQ",
            assetClass: "crypto",
            interval: "1h",
            startDate: "2026-02-01",
            endDate: "2026-06-01",
          }),
        },
        "Saved and validated",
        { version: 1 },
      ),
      tool(
        "finny_backtest",
        backtestInput({ interval: "1h", startDate: "2026-02-01", endDate: "2026-06-01" }),
        "Verdict: failed\nTotal return: -1%\nEligibility: backtested",
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, scenario)
    const codes = observed.violations.map((item) => item.code)
    expect(codes).toContain("request_symbol_mismatch")
    expect(codes).toContain("request_asset_class_mismatch")
    expect(codes).toContain("request_interval_mismatch")
    expect(codes).toContain("request_start_date_mismatch")
    expect(codes).toContain("request_end_date_mismatch")
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "contract_failed",
      exitCode: 2,
    })
  })

  test("strategy family comes from structured mission and config fields, never candidate names or prose", () => {
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "finny_algorithm_save",
        {
          name: "spy-sma-crossover",
          description: "An SMA crossover candidate whose name repeats sma-crossover",
          config: savedConfig(),
          mission: mission({ family: "roc-momentum" }),
          reasoning: "The requested SMA crossover phrase appears here too.",
        },
        "Saved and validated",
        { version: 1 },
      ),
      tool("finny_backtest", backtestInput(), "Verdict: failed\nTotal return: -1%\nEligibility: backtested"),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, scenario)
    expect(observed.violations.map((item) => item.code)).toContain("strategy_family_drift")
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "contract_failed",
      exitCode: 2,
    })
  })

  test("batched task children expand into deduplicated subagents and enforce the limit", () => {
    const events = [
      tool("task", { tasks: [{ description: "one" }, { description: "two" }, { description: "three" }] }, "", {
        subagents: [
          { id: "child-1", type: "data_extractor" },
          { id: "child-2", type: "news_agent" },
          { id: "child-3", type: "sec_agent" },
          { id: "child-2", type: "news_agent" },
        ],
      }),
    ]
    const observed = observeRun(events, scenario)
    expect(observed.subagents).toEqual([
      { id: "child-1", type: "data_extractor" },
      { id: "child-2", type: "news_agent" },
      { id: "child-3", type: "sec_agent" },
    ])
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "contract_failed",
      exitCode: 2,
    })
    expect(observed.violations.map((violation) => violation.code)).toContain("subagent_limit")
  })

  test("required observability without a trace grader fails closed as evidence invalid", () => {
    const observed = observeRun([], scenario)
    expect(
      classifyOutcome({
        childExitCode: 0,
        observation: observed,
        observabilityRequired: true,
        observabilityAvailable: false,
      }),
    ).toEqual({ status: "evidence_invalid", exitCode: 5 })
  })

  test("integrity evidence takes precedence over timeout", () => {
    const observed = observeRun([], scenario)
    expect(
      classifyOutcome({
        childExitCode: 1,
        timedOut: true,
        integrityErrors: ["run.json hash mismatch"],
        observation: observed,
      }),
    ).toEqual({ status: "evidence_invalid", exitCode: 5 })
  })

  test("completed stages with missing structured identity fields fail closed", () => {
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "finny_algorithm_save",
        { name: "spy-sma-crossover", config: JSON.stringify({}), mission: mission({ family: "sma-crossover" }) },
        "Saved and validated",
        { version: 1 },
      ),
      tool(
        "finny_backtest",
        { algorithmName: "spy-sma-crossover" },
        "Verdict: failed\nTotal return: -1%\nEligibility: backtested",
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, scenario)
    expect(observed.violations.map((item) => item.code)).toContain("request_identity_missing")
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "contract_failed",
      exitCode: 2,
    })
  })

  test("preflight and runtime failures have distinct exits", () => {
    const observed = observeRun([], scenario)
    expect(classifyOutcome({ preflightFailed: true, observation: observed })).toEqual({
      status: "preflight_failed",
      exitCode: 3,
    })
    expect(classifyOutcome({ childExitCode: 1, observation: observed })).toEqual({
      status: "execution_failed",
      exitCode: 4,
    })
  })
})

describe("atomic bundle publication", () => {
  // @codescene(disable-all) This test intentionally verifies the complete publication transaction.
  test("publishes a schema-valid manifest and checksum bundle with one rename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-bundle-"))
    roots.push(root)
    const writer = await createBundleWriter({ outputDir: root, runId: "run-1" })
    await writeBundleText({ writer: writer, relative: "raw/stdout.log", content: "ok\n" })
    const now = new Date().toISOString()
    const base: Omit<RunManifestV1, "artifacts" | "integrity"> = {
      schemaVersion: "1.0.0",
      runId: "run-1",
      scenarioId: "fixture",
      status: "completed",
      exitCode: 0,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      source: {
        ref: "HEAD",
        commit: "abc",
        targetTreeHash: "tree",
        treeState: "clean",
        preparation: "test_current_checkout",
        bunLockSha256: "a",
        evaluatorSourceSha256: "b".repeat(64),
        evaluatorEntrypointSha256: "c".repeat(64),
        scenarioSha256: scenarioSha256(scenario),
      },
      runtime: { os: "test", arch: "test", bunVersion: "test" },
      model: { id: "test/model", agent: "finny" },
      isolation: {
        namespace: "run-1",
        reusedState: false,
        finnyHome: "isolated/finny-home",
        database: "isolated/db",
        xdgData: "isolated/data",
        xdgState: "isolated/state",
        xdgCache: "isolated/cache",
        xdgConfig: "isolated/config",
        phoenixProject: "run-1",
        ports: { http: 1 },
        cleanupStatus: "completed",
      },
      attempts: [],
      sessions: { subagents: [] },
      stages: {},
      requestAdherence: { expected: {}, observed: {}, violations: [] },
      strategyResults: [],
      recoveries: [],
      errors: [],
      observability: {
        required: false,
        project: "run-1",
        traceIds: [],
        spanCount: 0,
        unattributedSpanCount: 0,
        paginationComplete: false,
        completionSpanFound: false,
        flush: "not_run",
        grade: "not_run",
      },
      semanticHashes: {
        source: "a".repeat(64),
        normalizedEvents: "b".repeat(64),
        contract: "c".repeat(64),
        strategyResults: "d".repeat(64),
      },
    }
    const result = await publishBundle(writer, base)
    expect(result.manifest.source.scenarioSha256).toBe(scenarioSha256(scenario))
    expect(result.manifest.integrity.artifactMerkleRoot).toHaveLength(64)
    await expect(fs.stat(path.join(root, ".run-1.tmp"))).rejects.toThrow()
    expect(await fs.readFile(path.join(root, "run-1", "checksums.sha256"), "utf8")).toContain("run-manifest.json")
  })
})
