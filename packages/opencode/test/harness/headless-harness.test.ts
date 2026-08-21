import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { createBundleWriter, publishBundle, writeBundleText } from "../../script/headless/artifacts"
import { runHeadlessHarness, semanticEventHash, semanticHash } from "../../script/headless/orchestrator"
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

const pivotScenario: HeadlessScenarioV1 = {
  schemaVersion: "1.0.0",
  id: "fixture-pivot",
  prompt: "build",
  asOfDate: "2026-07-09",
  limits: { wallTimeMs: 30_000, modelTurns: 20, toolCalls: 20, subagents: 1 },
  request: {
    symbols: ["SPY"],
    assetClass: "equity",
    interval: "5m",
    strategyFamilies: ["sma-crossover"],
    startDate: "2026-01-09",
    endDate: "2026-07-08",
  },
  allowedSuccessorFamilies: ["mean-reversion", "momentum"],
  artifactPolicy: { maxAlgorithms: 3, maxVersionsPerAlgorithm: 2, maxBacktests: 4 },
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

function structuredDocsInput(family: string) {
  return {
    mission: {
      hypothesis: "fixture",
      scope: { asset_class: "equities", universe: ["SPY"], horizon: "intraday" },
      strategy: {
        bar_interval: "5min",
        type: family,
        direction: "long",
        entry_signal: "crossover",
        risk_profile: "bounded",
        max_drawdown_pct: "10%",
        backtest_window: "2026-01-09 through 2026-07-08",
        success_metric: "return",
      },
      risk_contract: {},
      exit_conditions: "exit",
      questionnaire: {
        market_universe: "SPY",
        timeframe_bar_interval: "5m",
        strategy_family: family,
        directional_thesis_regime: "trend",
        entry_signal_idea: "crossover",
        exit_invalidation_rules: "cross back",
        risk_tolerance_max_drawdown: "10%",
        backtest_window_success_metric: "window; return",
      },
    },
  }
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

  test("semantic event hashes ignore checkout snapshots and generated workspace slugs only", () => {
    const event = (snapshot: string, workspace: string, symbol = "SPY") => [
      {
        type: "tool_use",
        part: {
          snapshot,
          tool: "finny_workspace_prepare",
          state: {
            input: { symbol, interval: "5m", strategyIntent: "sma-crossover" },
            output: `workspace_slug: ${workspace}\nworkspace_path: /tmp/${workspace}/mission.md`,
          },
        },
      },
    ]
    const left = event("f478dbd65679d8aa116828644cce447e29a4a10a", "spy-5m-strategy.10.7.04.26.4147d1a6")
    const right = event("f5b7bed6a4f7ecd2c22350b88248eca2a7f0a61d", "spy-5m-strategy.10.7.04.27.8697a6c5")

    expect(semanticHash(left)).toBe(semanticHash(right))
    expect(semanticHash(left)).not.toBe(
      semanticHash(event("another-snapshot", "spy-5m-strategy.10.7.04.28.abcdef12", "QQQ")),
    )
  })

  test("semantic hashes retain integrity fields while normalizing runtime-only bindings", () => {
    const source = {
      scenarioSha256: "a".repeat(64),
      bunLockSha256: "b".repeat(64),
      evaluatorSourceSha256: "c".repeat(64),
      evaluatorEntrypointSha256: "d".repeat(64),
      manifestHash: "3".repeat(64),
    }
    const value = (runtime: {
      sessionID: string
      timestamp: string
      root: string
      requestHash: string
      configHash: string
    }) => ({
      source,
      runtime: {
        sessionID: runtime.sessionID,
        timestamp: runtime.timestamp,
        artifactPath: `${runtime.root}/bundle`,
        requestHash: runtime.requestHash,
        configHash: runtime.configHash,
        transcript: `root=${runtime.root} request_content_hash: sha256:${runtime.requestHash}`,
      },
    })
    const leftRuntime = {
      sessionID: "ses_left",
      timestamp: "2026-07-26T10:00:00.000Z",
      root: "/tmp/headless-left",
      requestHash: "e".repeat(64),
      configHash: "f".repeat(64),
    }
    const rightRuntime = {
      sessionID: "ses_right",
      timestamp: "2026-07-26T11:00:00.000Z",
      root: "/tmp/headless-right",
      requestHash: "1".repeat(64),
      configHash: "2".repeat(64),
    }

    expect(semanticHash(value(leftRuntime), [leftRuntime.root])).toBe(
      semanticHash(value(rightRuntime), [rightRuntime.root]),
    )
    for (const key of [
      "scenarioSha256",
      "bunLockSha256",
      "evaluatorSourceSha256",
      "evaluatorEntrypointSha256",
      "manifestHash",
    ] as const) {
      const changed = value(leftRuntime)
      changed.source = { ...source, [key]: "9".repeat(64) }
      expect(semanticHash(changed, [leftRuntime.root])).not.toBe(semanticHash(value(leftRuntime), [leftRuntime.root]))
    }
  })

  test("semantic strategy-result hashes retain the complete strict-run identity", () => {
    const hash = (character: string) => character.repeat(64)
    const identity = {
      strategyHash: hash("1"),
      savedConfigHash: hash("2"),
      effectiveConfigHash: hash("3"),
      documentHashes: {
        mission: hash("4"),
        preferences: hash("5"),
        decisions: hash("6"),
        reasoning: hash("7"),
      },
      riskContractHash: hash("8"),
      rawDataHash: hash("9"),
      processedDataHash: hash("a"),
      manifestHash: hash("b"),
      engineTreeHash: hash("c"),
      assetProfileHash: hash("d"),
      executionProfileHash: hash("e"),
      experimentPlanHash: hash("f"),
      qualificationPolicyHash: hash("0"),
    }
    const baseline = semanticHash({ identity })

    for (const key of [
      "strategyHash",
      "savedConfigHash",
      "effectiveConfigHash",
      "riskContractHash",
      "rawDataHash",
      "processedDataHash",
      "engineTreeHash",
      "assetProfileHash",
      "executionProfileHash",
      "experimentPlanHash",
      "qualificationPolicyHash",
    ] as const) {
      expect(semanticHash({ identity: { ...identity, [key]: hash(key === "strategyHash" ? "a" : "1") } })).not.toBe(
        baseline,
      )
    }
    for (const key of ["mission", "preferences", "decisions", "reasoning"] as const) {
      expect(
        semanticHash({
          identity: {
            ...identity,
            documentHashes: { ...identity.documentHashes, [key]: hash(key === "mission" ? "a" : "1") },
          },
        }),
      ).not.toBe(baseline)
    }

    expect(semanticHash({ identity: { ...identity, manifestHash: hash("a") } })).toBe(baseline)
  })

  test("semantic hashes ignore generated strict-run manifest bindings", () => {
    const result = (algorithmId: string, manifestHash: string) => [
      {
        artifactPath: `algorithms/${algorithmId}/v01/runs/20260711T013417Z-f021d7eb68be46d4/run.json`,
        runId: "20260711T013417Z-f021d7eb68be46d4",
        identity: {
          algorithmId,
          strategyHash: "fixed-strategy",
          rawDataHash: "fixed-fixture-data",
          manifestHash,
        },
        validationStatus: "passed",
        unifiedVerdict: "failed",
      },
    ]
    const left = result("d4806b58-6fd5-4f3c-8385-11e3cef5df4e", "a".repeat(64))
    const right = result("cfa716f8-fe03-483a-83f1-61d2b54b9847", "b".repeat(64))

    expect(semanticHash(left)).toBe(semanticHash(right))
    expect(semanticHash(left)).not.toBe(semanticHash([{ ...left[0], unifiedVerdict: "passed" }]))
  })

  test("semantic event hashes ignore runtime RequestSpec bindings", () => {
    const event = (sessionID: string, contentHash: string, conceptId: string, configHash: string) => [
      {
        type: "tool_use",
        sessionID,
        part: {
          tool: "finny_workspace_prepare",
          state: {
            output: `request_id: ${sessionID}\nrequest_content_hash: sha256:${contentHash}`,
            metadata: { request_id: sessionID, request_content_hash: `sha256:${contentHash}`, conceptId, configHash },
          },
        },
      },
    ]
    const left = event("ses_one", "a".repeat(64), "b".repeat(64), "c".repeat(64))
    const right = event("ses_two", "d".repeat(64), "e".repeat(64), "f".repeat(64))

    expect(semanticHash(left)).toBe(semanticHash(right))
  })

  test("semantic event hash ignores generated event bindings but retains observed behavior", () => {
    const events = (sessionID: string, contentHash: string) => [
      tool(
        "finny_workspace_prepare",
        requestInput(),
        `request_id: ${sessionID}\nrequest_content_hash: sha256:${contentHash}`,
        { sessionId: sessionID, request_content_hash: `sha256:${contentHash}` },
      ),
      {
        type: "text",
        part: {
          text: "Return: measured. Sharpe: measured. Max drawdown: measured. Eligibility: backtested. Next step: review.",
        },
      },
    ]
    expect(semanticEventHash(observeRun(events("ses_one", "a".repeat(64)), scenario))).toBe(
      semanticEventHash(observeRun(events("ses_two", "b".repeat(64)), scenario)),
    )
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

  test("barrier-delivered manifests and structured docsInput satisfy the saved-candidate contract", () => {
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "task_start",
        { description: "Collect evidence", prompt: "Collect fixture data", subagent_type: "data_extractor" },
        "The task is working in the background.",
      ),
      tool(
        "finny_strategy_context_wait",
        {},
        "<context_task><data-extractor-manifest>\nusable_for_parent: yes\n</data-extractor-manifest></context_task>",
      ),
      tool(
        "finny_algorithm_save",
        {
          name: "spy-sma",
          config: JSON.stringify({
            symbols: ["SPY"],
            asset_class: "equity",
            interval: "5min",
            backtest: { start_date: "2026-01-09", end_date: "2026-07-08" },
          }),
          docsInput: {
            mission: {
              hypothesis: "SMA crossover follows the synthetic trend.",
              scope: { asset_class: "equities", universe: ["SPY"], horizon: "intraday" },
              strategy: {
                bar_interval: "5min",
                type: "sma-crossover",
                direction: "long",
                entry_signal: "fast SMA crosses above slow SMA",
                risk_profile: "bounded intraday risk",
                max_drawdown_pct: "10%",
                backtest_window: "2026-01-09 through 2026-07-08",
                success_metric: "positive risk-adjusted return",
              },
              risk_contract: {},
              exit_conditions: "Death cross or protective stop.",
              questionnaire: {
                market_universe: "SPY equities",
                timeframe_bar_interval: "5 minute bars",
                strategy_family: "sma-crossover",
                directional_thesis_regime: "trending regime",
                entry_signal_idea: "SMA crossover",
                exit_invalidation_rules: "death cross or stop",
                risk_tolerance_max_drawdown: "10%",
                backtest_window_success_metric: "2026-01-09 through 2026-07-08; Sharpe",
              },
            },
          },
        },
        "Saved and validated",
        { name: "spy-sma", version: 1 },
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
    const observed = observeRun(events, {
      ...scenario,
      limits: { ...scenario.limits, toolCalls: 6 },
      requiredStages: ["evidence_ready", ...scenario.requiredStages],
    })
    expect(observed.violations).toEqual([])
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "completed",
      exitCode: 0,
    })
  })

  test("qualified SMA crossover family labels remain within the requested family", () => {
    const family = "SMA crossover trend-following (long-only)"
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "finny_algorithm_save",
        {
          name: "spy-sma",
          config: JSON.stringify({
            symbols: ["SPY"],
            asset_class: "equity",
            interval: "5min",
            backtest: { start_date: "2026-01-09", end_date: "2026-07-08" },
          }),
          docsInput: structuredDocsInput(family),
        },
        "Saved and validated",
        { name: "spy-sma", version: 1 },
      ),
      tool(
        "finny_backtest",
        backtestInput({ algorithmName: "spy-sma" }),
        "Total return: -10%\nVerdict: failed\nEligibility: backtested",
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, scenario)
    expect(observed.requestIdentity.strategyFamilies).toEqual(["sma-crossover"])
    expect(observed.violations).toEqual([])
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

  test("qualified SMA crossover mission wording canonicalizes to the requested family", () => {
    const family = "SMA crossover trend-following (long-only)"
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "finny_algorithm_save",
        {
          name: "spy-sma-crossover",
          config: JSON.stringify({
            symbol: "SPY",
            asset_class: "equity",
            interval: "5min",
            backtest: { start_date: "2026-01-09", end_date: "2026-07-08" },
          }),
          docsInput: structuredDocsInput(family),
        },
        "Saved and validated",
        { name: "spy-sma-crossover", version: 1 },
      ),
      tool("finny_backtest", backtestInput(), "Verdict: inconclusive\nTotal return: 0%\nEligibility: backtested"),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, scenario)
    expect(observed.requestIdentity.strategyFamilies).toEqual(["sma-crossover"])
    expect(observed.violations.map((item) => item.code)).not.toContain("strategy_family_drift")
    expect(observed.violations).toEqual([])
  })

  test("pivot to an allowed successor family after a diagnosed strategy_loss is admissible", () => {
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
        { algorithmName: "spy-sma" },
        "Total return: -10%\nVerdict: failed\nEligibility: backtested\nfailure_diagnosis: strategy_loss",
        { failure_diagnosis: { classification: "strategy_loss", engineRan: true } },
      ),
      tool(
        "finny_algorithm_save",
        { name: "spy-mean", mission: mission({ family: "mean-reversion" }), config: savedConfig() },
        "Saved and validated",
        { version: 1 },
      ),
      tool(
        "finny_backtest",
        backtestInput({ algorithmName: "spy-mean" }),
        "Total return: -5%\nVerdict: failed\nEligibility: backtested",
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, pivotScenario)
    expect(observed.violations.map((item) => item.code)).not.toContain("strategy_family_drift")
    expect(observed.violations.map((item) => item.code)).not.toContain("strategy_pivot_without_diagnosed_loss")
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "completed",
      exitCode: 0,
    })
  })

  test("pivot to a successor family without a diagnosed strategy_loss fails the contract", () => {
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
        { algorithmName: "spy-sma" },
        "Total return: -10%\nVerdict: failed\nEligibility: backtested\nfailure_diagnosis: zero_trades",
        { failure_diagnosis: { classification: "zero_trades", engineRan: true } },
      ),
      tool(
        "finny_algorithm_save",
        { name: "spy-mean", mission: mission({ family: "mean-reversion" }), config: savedConfig() },
        "Saved and validated",
        { version: 1 },
      ),
      tool(
        "finny_backtest",
        { algorithmName: "spy-mean" },
        "Total return: -5%\nVerdict: failed\nEligibility: backtested",
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, pivotScenario)
    expect(observed.violations.map((item) => item.code)).toContain("strategy_pivot_without_diagnosed_loss")
    expect(classifyOutcome({ childExitCode: 0, observation: observed })).toEqual({
      status: "contract_failed",
      exitCode: 2,
    })
  })

  test("pivot to a successor family is rejected for sizing_failure, strategy_exception, and data blockers", () => {
    for (const classification of ["sizing_failure", "strategy_exception", "data_blocked"]) {
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
          { algorithmName: "spy-sma" },
          `Verdict: failed\nTotal return: -10%\nEligibility: backtested\nfailure_diagnosis: ${classification}`,
          { failure_diagnosis: { classification, engineRan: classification !== "data_blocked" } },
        ),
        tool(
          "finny_algorithm_save",
          { name: "spy-curl", mission: mission({ family: "momentum" }), config: savedConfig() },
          "Saved and validated",
          { version: 1 },
        ),
        { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
      ]
      const observed = observeRun(events, {
        ...pivotScenario,
        artifactPolicy: { maxAlgorithms: 2, maxVersionsPerAlgorithm: 2, maxBacktests: 4 },
      })
      expect(observed.violations.map((item) => item.code)).toContain(
        "strategy_pivot_without_diagnosed_loss",
      )
    }
  })

  test("scenario without allowedSuccessorFamilies still hard-fails any family drift", () => {
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
        { algorithmName: "spy-sma" },
        "Total return: -10%\nVerdict: failed\nEligibility: backtested\nfailure_diagnosis: strategy_loss",
        { failure_diagnosis: { classification: "strategy_loss", engineRan: true } },
      ),
      tool(
        "finny_algorithm_save",
        { name: "spy-mean", mission: mission({ family: "mean-reversion" }), config: savedConfig() },
        "Saved and validated",
        { version: 1 },
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, pivotScenario)
    // Regression guard: the strict scenario (no field) keeps rejecting drift.
    const strictScenario = { ...pivotScenario, allowedSuccessorFamilies: undefined }
    const strictObserved = observeRun(events, strictScenario)
    expect(strictObserved.violations.map((item) => item.code)).toContain("strategy_family_drift")
    // The same candidate sequence with the field set and a diagnosed loss is clean.
    expect(observed.violations.map((item) => item.code)).not.toContain("strategy_family_drift")
  })

  test("a candidate outside the declared successor set is still drift even with the field set", () => {
    const events = [
      tool("finny_workspace_prepare", requestInput(), "Prepared"),
      tool(
        "finny_algorithm_save",
        { name: "spy-bt", mission: mission({ family: "breakout" }), config: savedConfig() },
        "Saved and validated",
        { version: 1 },
      ),
      { type: "text", sessionID: "ses_main", part: { text: "return sharpe max drawdown eligibility next step" } },
    ]
    const observed = observeRun(events, pivotScenario)
    expect(observed.violations.map((item) => item.code)).toContain("strategy_family_drift")
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

  test("runtime failure takes precedence over induced observability gaps", () => {
    const observed = observeRun([], scenario)
    expect(
      classifyOutcome({
        childExitCode: 1,
        timedOut: true,
        observabilityErrors: ["telemetry flush was not_run"],
        observation: observed,
      }),
    ).toEqual({ status: "timed_out", exitCode: 4 })
    expect(
      classifyOutcome({
        childExitCode: 1,
        observabilityErrors: ["completion span missing"],
        observation: observed,
      }),
    ).toEqual({ status: "execution_failed", exitCode: 4 })
    expect(
      classifyOutcome({
        childExitCode: 0,
        observabilityErrors: ["completion span missing"],
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
    expect(classifyOutcome({ integrityErrors: ["observability invalid"], observation: observed })).toEqual({
      status: "evidence_invalid",
      exitCode: 5,
    })
  })
})

describe("atomic bundle publication", () => {
  // @codescene(disable-all) This test intentionally verifies the complete publication transaction.
  test("publishes a schema-valid manifest and checksum bundle with one rename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-bundle-"))
    roots.push(root)
    const writer = await createBundleWriter(root, "run-1")
    await writeBundleText(writer, "raw/stdout.log", "ok\n")
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
