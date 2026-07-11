import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createBundleWriter } from "../../script/headless/artifacts"
import { startFixtureMarketDataProvider } from "../../script/headless/fixture-market-data"
import { startScriptedModelServer } from "../../script/headless/fixture-model"
import { configureCollector, createIsolation } from "../../script/headless/isolation"
import { runHeadlessHarnessPromise } from "../../script/headless/orchestrator"
import {
  artifactCaptureDecision,
  bindObservedStrictRuns,
  collectFinnyArtifacts,
  expectedBacktestArtifactIssues,
  inspectStrategyResults,
} from "../../script/headless/run-artifacts"
import type { VerifiedHarnessRun } from "../../script/headless/run-artifacts"
import { loadScenario } from "../../script/headless/scenario"
import { classifyOutcome, observeRun } from "../../script/headless/semantic-verdict"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => item().catch(() => {})))
})

const repo = path.resolve(import.meta.dir, "../../../..")
const scenario = path.join(repo, "packages/opencode/harness/scenarios/spy-5m-sma-crossover.v1.json")

async function allText(root: string): Promise<string> {
  const parts: string[] = []
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else parts.push(await fs.readFile(file, "utf8"))
    }
  }
  await walk(root)
  return parts.join("\n")
}

describe("headless-only fixture boundaries", () => {
  test("fixture servers reject callers that do not explicitly opt into harness mode", async () => {
    const isolation = await createIsolation("fixture-deny-test")
    cleanup.push(() => fs.rm(isolation.root, { recursive: true, force: true }))
    await expect(
      startScriptedModelServer({
        port: isolation.ports.scriptedModel,
        mode: "negative",
        harnessMode: false as true,
      }),
    ).rejects.toThrow("explicit harness mode")
    await expect(
      startFixtureMarketDataProvider({
        port: isolation.ports.fixtureMarketData,
        allowedRoot: isolation.finnyHome,
        fixtureRoot: path.join(isolation.root, "fixture"),
        harnessMode: false as true,
      }),
    ).rejects.toThrow("explicit harness mode")
  })

  test("collector propagation accepts only credential-free HTTP endpoints", () => {
    const env: Record<string, string> = {}
    configureCollector(env, "http://127.0.0.1:4318/")
    expect(env.PHOENIX_COLLECTOR_ENDPOINT).toBe("http://127.0.0.1:4318")
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    expect(() => configureCollector({}, "file:///tmp/traces")).toThrow("http or https")
    expect(() => configureCollector({}, "https://user:pass@example.test")).toThrow("must not contain credentials")
  })

  test("scripted model is explicit and exposes OpenAI-compatible streaming", async () => {
    const isolation = await createIsolation("fixture-model-test")
    cleanup.push(() => fs.rm(isolation.root, { recursive: true, force: true }))
    const server = await startScriptedModelServer({
      port: isolation.ports.scriptedModel,
      mode: "negative",
      harnessMode: true,
    })
    cleanup.push(server.stop)
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "scripted", stream: true, messages: [{ role: "user", content: "build" }] }),
    })
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain("finny_workspace_prepare")
    expect(body).toContain("data: [DONE]")
    expect(server.requests()).toBe(1)
    expect(server.configContent).toContain("@ai-sdk/openai-compatible")
  })

  test("market provider writes only under the isolated Finny home", async () => {
    const isolation = await createIsolation("fixture-market-test")
    cleanup.push(() => fs.rm(isolation.root, { recursive: true, force: true }))
    const provider = await startFixtureMarketDataProvider({
      port: isolation.ports.fixtureMarketData,
      allowedRoot: isolation.finnyHome,
      fixtureRoot: path.join(isolation.root, "fixture"),
      harnessMode: true,
    })
    cleanup.push(provider.stop)
    const outputDir = path.join(isolation.finnyHome, "algos", "spy", "data")
    const ok = await fetch(
      `${provider.url}/v1/materialize?output_dir=${encodeURIComponent(outputDir)}&algorithm=spy-sma-crossover`,
    )
    const materialized = (await ok.json()) as Record<string, unknown>
    expect(ok.status).toBe(200)
    expect(materialized.usable_for_parent).toBe("yes")
    expect(await fs.readFile(path.join(outputDir, String(materialized.output_path)), "utf8")).toContain(
      "timestamp,open,high,low,close,volume",
    )
    const escaped = await fetch(
      `${provider.url}/v1/materialize?output_dir=${encodeURIComponent(path.join(os.tmpdir(), "escaped"))}`,
    )
    expect(escaped.status).toBe(403)
    expect(provider.csvSha256).toHaveLength(64)
  })

  test("two fixture isolations share no state paths, projects, or ports", async () => {
    const [left, right] = await Promise.all([createIsolation("concurrent-left"), createIsolation("concurrent-right")])
    cleanup.push(
      () => fs.rm(left.root, { recursive: true, force: true }),
      () => fs.rm(right.root, { recursive: true, force: true }),
    )
    expect(left.root).not.toBe(right.root)
    expect(left.database).not.toBe(right.database)
    expect(left.finnyHome).not.toBe(right.finnyHome)
    expect(left.phoenixProject).not.toBe(right.phoenixProject)
    expect(new Set([...Object.values(left.ports), ...Object.values(right.ports)]).size).toBe(
      Object.keys(left.ports).length + Object.keys(right.ports).length,
    )
  })

  test("live Alpaca credentials cross the isolation boundary under provider-native names", async () => {
    const priorKey = process.env.ALPACA_API_KEY_ID
    const priorSecret = process.env.ALPACA_API_SECRET_KEY
    process.env.ALPACA_API_KEY_ID = "harness-key-id"
    process.env.ALPACA_API_SECRET_KEY = "harness-secret-key"
    try {
      const isolation = await createIsolation("alpaca-env-test")
      cleanup.push(() => fs.rm(isolation.root, { recursive: true, force: true }))
      expect(isolation.env.ALPACA_API_KEY_ID).toBe("harness-key-id")
      expect(isolation.env.ALPACA_API_SECRET_KEY).toBe("harness-secret-key")
      expect(isolation.credentialPresence.map((item) => item.name)).toEqual(
        expect.arrayContaining(["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"]),
      )
    } finally {
      if (priorKey === undefined) delete process.env.ALPACA_API_KEY_ID
      else process.env.ALPACA_API_KEY_ID = priorKey
      if (priorSecret === undefined) delete process.env.ALPACA_API_SECRET_KEY
      else process.env.ALPACA_API_SECRET_KEY = priorSecret
    }
  })

  test("missing dependencies fail before a fixture model request and bundles redact secrets", async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-preflight-"))
    cleanup.push(() => fs.rm(output, { recursive: true, force: true }))
    const prior = process.env.OPENAI_API_KEY
    const secret = "sk-headless-must-not-appear-123456"
    process.env.OPENAI_API_KEY = secret
    try {
      const result = await runHeadlessHarnessPromise({
        ref: "HEAD",
        scenarioPath: scenario,
        model: "harness/scripted",
        agent: "finny",
        outputDir: output,
        repository: repo,
        testOnlyUseCurrentSource: true,
        fixtureMode: "negative",
        requiredDependencyPaths: ["definitely/not-installed"],
      })
      expect(result.exitCode).toBe(3)
      expect(result.manifest.status).toBe("preflight_failed")
      expect(result.manifest.model.requestCount).toBe(0)
      expect(await allText(result.bundlePath)).not.toContain(secret)
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prior
    }
  })

  // @codescene(disable-all) This test intentionally exercises the complete integrity matrix.
  test("malformed, schema-invalid, and hash-invalid strict runs are retained but force integrity exit 5", async () => {
    const finnyHome = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-integrity-"))
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-integrity-bundle-"))
    cleanup.push(
      () => fs.rm(finnyHome, { recursive: true, force: true }),
      () => fs.rm(output, { recursive: true, force: true }),
    )

    const malformed = path.join(finnyHome, "algorithms", "bad", "v01", "runs", "malformed")
    const invalidSchema = path.join(finnyHome, "algorithms", "bad", "v01", "runs", "schema-invalid")
    const invalidHash = path.join(finnyHome, "algorithms", "bad", "v01", "runs", "hash-invalid")
    await Promise.all([malformed, invalidSchema, invalidHash].map((dir) => fs.mkdir(dir, { recursive: true })))
    await fs.writeFile(path.join(malformed, "run.json"), "{not-json\n")
    await fs.writeFile(path.join(invalidSchema, "run.json"), JSON.stringify({ schema: "wrong", version: 99 }))
    await fs.writeFile(path.join(invalidSchema, "artifact-manifest.json"), "{}\n")

    const hash = "a".repeat(64)
    const identity = {
      schema: "finny.run_identity",
      version: 1,
      algorithmId: "bad",
      algorithmVersion: 1,
      strategyHash: hash,
      savedConfigHash: hash,
      effectiveConfigHash: hash,
      documentHashes: { mission: hash, preferences: hash, decisions: hash, reasoning: hash },
      riskContractHash: hash,
      rawDataHash: hash,
      processedDataHash: hash,
      manifestHash: hash,
      engineTreeHash: hash,
      assetProfileHash: hash,
      executionProfileHash: hash,
      seed: 1,
      dateWindow: { start: "2026-01-09", end: "2026-07-08", interval: "5m" },
    }
    await fs.writeFile(
      path.join(invalidHash, "run.json"),
      JSON.stringify({
        schema: "finny.strict_run",
        version: 1,
        runId: "hash-invalid",
        productLabel: "Crucible 2.0",
        runKind: "crucible_2_0",
        createdAt: new Date().toISOString(),
        identity,
        identityHash: "b".repeat(64),
        recommendation: { verdict: "failed", reasons: [] },
        validationStatus: "passed",
      }),
    )
    await fs.writeFile(
      path.join(invalidHash, "artifact-manifest.json"),
      JSON.stringify({
        schema: "finny.run_manifest",
        version: 1,
        runId: "hash-invalid",
        identityHash: "b".repeat(64),
        manifestHash: "b".repeat(64),
        runJsonSha256: "b".repeat(64),
        files: [],
      }),
    )

    const writer = await createBundleWriter(output, "integrity-test")
    const collected = await collectFinnyArtifacts({ writer, finnyHome, secretValues: [] })
    const retained = collected.index.find((entry) => entry.source.endsWith(path.join("malformed", "run.json")))
    expect(retained).toBeDefined()
    expect(await fs.readFile(path.join(writer.stagingDir, retained!.object), "utf8")).toBe("{not-json\n")

    const inspected = await inspectStrategyResults(finnyHome)
    const messages = inspected.issues.map((issue) => issue.message).join("\n")
    expect(messages).toContain("strict run metadata is unreadable")
    expect(messages).toContain("missing the v1 identity or manifest")
    expect(messages).toContain("canonical run identity hash mismatch")
    const observed = observeRun([], await loadScenario(scenario))
    expect(
      classifyOutcome({ observation: observed, integrityErrors: inspected.issues.map((issue) => issue.message) }),
    ).toEqual({ status: "evidence_invalid", exitCode: 5 })
    expect(inspected.results).toEqual([])
  })

  test("a completed backtest transcript without a verifier-valid strict run exits 5", async () => {
    const observed = observeRun(
      [
        {
          type: "tool_use",
          sessionID: "ses_main",
          part: {
            tool: "finny_backtest",
            state: {
              status: "completed",
              input: { interval: "5min", startDate: "2026-01-09", endDate: "2026-07-08" },
              output: "Verdict: failed\nTotal return: -1%\nEligibility: backtested",
              metadata: {},
            },
          },
        },
      ],
      await loadScenario(scenario),
    )
    const issues = expectedBacktestArtifactIssues(observed.completedBacktests, 0)
    expect(issues.map((issue) => issue.message).join("\n")).toContain("0 verifier-valid strict run")
    expect(classifyOutcome({ observation: observed, integrityErrors: issues.map((issue) => issue.message) })).toEqual({
      status: "evidence_invalid",
      exitCode: 5,
    })
  })

  test("artifact capture excludes runtime trees and enforces file and byte caps", async () => {
    const finnyHome = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-policy-"))
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-policy-bundle-"))
    cleanup.push(
      () => fs.rm(finnyHome, { recursive: true, force: true }),
      () => fs.rm(output, { recursive: true, force: true }),
    )
    const algorithm = path.join(finnyHome, "algorithms", "algo-1", "v01")
    const run = path.join(algorithm, "runs", "run-1")
    await fs.mkdir(path.join(run, ".venv", "lib"), { recursive: true })
    await fs.mkdir(path.join(run, "node_modules", "pkg"), { recursive: true })
    await fs.mkdir(path.join(run, "__pycache__"), { recursive: true })
    await fs.writeFile(path.join(algorithm, "mission.md"), "mission\n")
    await fs.writeFile(path.join(algorithm, "config.json"), "{}\n")
    await fs.writeFile(path.join(run, "run.json"), "{}\n")
    await fs.writeFile(path.join(run, "engine.so"), "compiled")
    await fs.writeFile(path.join(run, ".venv", "lib", "runtime.py"), "runtime")
    await fs.writeFile(path.join(run, "node_modules", "pkg", "index.js"), "runtime")
    await fs.writeFile(path.join(run, "__pycache__", "strategy.pyc"), "runtime")

    expect(artifactCaptureDecision(path.join("algorithms", "algo-1", "v01", "runs", "run-1", ".venv", "x"))).toEqual({
      include: false,
      reason: "runtime_directory",
    })
    expect(artifactCaptureDecision(path.join("algorithms", "algo-1", "v01", "runs", "run-1", "engine.so"))).toEqual({
      include: false,
      reason: "compiled_runtime",
    })

    const writer = await createBundleWriter(output, "policy-test")
    const collected = await collectFinnyArtifacts({ writer, finnyHome, secretValues: [] })
    expect(collected.index.map((entry) => entry.source).sort()).toEqual([
      path.join("algorithms", "algo-1", "v01", "config.json"),
      path.join("algorithms", "algo-1", "v01", "mission.md"),
      path.join("algorithms", "algo-1", "v01", "runs", "run-1", "run.json"),
    ])
    expect(collected.capture.excluded.runtime_directory.entries).toBe(3)
    expect(collected.capture.includedBytes).toBeLessThan(1024)

    const cappedWriter = await createBundleWriter(output, "policy-cap-test")
    const capped = await collectFinnyArtifacts({
      writer: cappedWriter,
      finnyHome,
      secretValues: [],
      limits: { maxFiles: 1, maxBytes: 1024, maxFileBytes: 1024 },
    })
    expect(capped.index).toHaveLength(1)
    expect(capped.issues.map((issue) => issue.message).join("\n")).toContain("capture exceeded limits")
  })

  test("target refs need not contain evaluator fixture modules", async () => {
    const oldRepo = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-old-ref-"))
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-old-ref-output-"))
    cleanup.push(
      () => fs.rm(oldRepo, { recursive: true, force: true }),
      () => fs.rm(output, { recursive: true, force: true }),
    )
    await fs.writeFile(path.join(oldRepo, "bun.lock"), "{}\n")
    await fs.writeFile(path.join(oldRepo, "README.md"), "legacy target without the headless evaluator\n")
    for (const args of [
      ["init"],
      ["config", "user.email", "harness@example.test"],
      ["config", "user.name", "Harness Test"],
      ["add", "."],
      ["commit", "-m", "legacy target"],
    ]) {
      const process = Bun.spawn(["git", ...args], { cwd: oldRepo, stdout: "pipe", stderr: "pipe" })
      expect(await process.exited).toBe(0)
    }
    await expect(
      fs.stat(path.join(oldRepo, "packages", "opencode", "script", "headless", "fixture-model.ts")),
    ).rejects.toThrow()

    const result = await runHeadlessHarnessPromise({
      ref: "HEAD",
      scenarioPath: scenario,
      model: "harness/scripted",
      agent: "finny",
      outputDir: output,
      repository: oldRepo,
      testOnlyUseCurrentSource: true,
      fixtureMode: "negative",
      requiredDependencyPaths: ["missing-before-model"],
    })
    expect(result.exitCode).toBe(3)
    expect(result.manifest.status).toBe("preflight_failed")
    expect(result.manifest.model.requestCount).toBe(0)
    expect(result.manifest.source.targetTreeHash).toHaveLength(40)
    expect(result.manifest.source.evaluatorSourceSha256).toHaveLength(64)
    expect(result.manifest.source.evaluatorEntrypointSha256).toHaveLength(64)
    expect(result.manifest.source.scenarioSha256).toHaveLength(64)
    expect(result.manifest.errors.some((error) => error.kind === "internal_error")).toBe(false)
  })

  test("same-id scenario mutations change manifest, source, and contract hashes", async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-scenario-hash-"))
    const inputs = await fs.mkdtemp(path.join(os.tmpdir(), "finny-headless-scenario-inputs-"))
    cleanup.push(
      () => fs.rm(output, { recursive: true, force: true }),
      () => fs.rm(inputs, { recursive: true, force: true }),
    )
    const baseline = await loadScenario(scenario)
    const variants = [
      baseline,
      { ...baseline, prompt: `${baseline.prompt} changed` },
      { ...baseline, limits: { ...baseline.limits, toolCalls: baseline.limits.toolCalls + 1 } },
      { ...baseline, requiredFinalFields: [...baseline.requiredFinalFields, "blockers"] },
    ]
    const results = []
    for (const [index, variant] of variants.entries()) {
      const file = path.join(inputs, `scenario-${index}.json`)
      await fs.writeFile(file, `${JSON.stringify(variant)}\n`)
      results.push(
        await runHeadlessHarnessPromise({
          ref: "HEAD",
          scenarioPath: file,
          model: "harness/scripted",
          agent: "finny",
          outputDir: output,
          repository: repo,
          testOnlyUseCurrentSource: true,
          fixtureMode: "negative",
          requiredDependencyPaths: ["missing-before-model"],
        }),
      )
    }
    expect(new Set(results.map((result) => result.manifest.scenarioId))).toEqual(new Set([baseline.id]))
    expect(new Set(results.map((result) => result.manifest.source.scenarioSha256)).size).toBe(4)
    expect(new Set(results.map((result) => result.manifest.semanticHashes.source)).size).toBe(4)
    expect(new Set(results.map((result) => result.manifest.semanticHashes.contract)).size).toBe(4)
    for (const result of results) {
      const bundled = (await fs.readFile(path.join(result.bundlePath, "inputs", "scenario.json"), "utf8")).trim()
      expect(JSON.parse(bundled).id).toBe(baseline.id)
      expect(result.manifest.status).toBe("preflight_failed")
      expect(result.manifest.model.requestCount).toBe(0)
    }
  })

  test("timestamped data-manifest windows normalize to scenario dates", () => {
    const hash = "a".repeat(64)
    const verified = {
      dir: "/tmp/finny-home/algorithms/algo/v01/runs/run-1",
      artifactPath: "algorithms/algo/v01/runs/run-1/run.json",
      run: {
        runId: "run-1",
        identity: {
          algorithmId: "algo",
          algorithmVersion: 1,
          dateWindow: { start: "2026-01-09T14:30:00Z", end: "2026-07-08T19:55:00Z", interval: "5min" },
          rawDataHash: hash,
        },
      },
      manifest: {},
      assetSpec: { symbol: "SPY", assetClass: "equity" },
      dataManifest: {
        symbols: ["SPY"],
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "5m",
        actual_interval: "5m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_start: "2026-01-09T00:00:00.000Z",
        requested_end: "2026-07-08T23:55:00.000Z",
        actual_start: "2026-01-09T14:30:00.000Z",
        actual_end: "2026-07-08T19:55:00.000Z",
        csv_sha256: hash,
        usable_for_parent: "yes",
      },
      strategyResult: {},
    } as unknown as VerifiedHarnessRun
    const issues = bindObservedStrictRuns({
      finnyHome: "/tmp/finny-home",
      savedCandidates: [{ name: "spy-sma", algorithmId: "algo", version: 1 }],
      backtests: [{ algorithmName: "spy-sma", runId: "run-1", artifactDir: verified.dir }],
      runs: [verified],
      scenario: {
        symbols: ["SPY"],
        assetClass: "equity",
        interval: "5m",
        startDate: "2026-01-09",
        endDate: "2026-07-08",
      },
    })
    expect(issues).toEqual([])
  })
})
