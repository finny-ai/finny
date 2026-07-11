import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sha256Bytes } from "../../script/headless/artifacts"
import { runHeadlessHarnessPromise } from "../../script/headless/orchestrator"
import type { FixtureScriptMode } from "../../script/headless/types"

const enabled = process.env.FINNY_HARNESS_E2E === "1"
const root = path.resolve(import.meta.dir, "../../../..")
const scenario = path.join(root, "packages/opencode/harness/scenarios/spy-5m-sma-crossover.v1.json")
const outputs: string[] = []

afterAll(async () => {
  await Promise.all(outputs.map((output) => fs.rm(output, { recursive: true, force: true })))
})

async function run(mode: FixtureScriptMode, source: "test_current_checkout" | "detached" = "test_current_checkout") {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), `finny-headless-e2e-${mode}-`))
  outputs.push(output)
  const fixtureScenario = path.join(output, "scenario.json")
  const parsedScenario = JSON.parse(await fs.readFile(scenario, "utf8")) as Record<string, unknown>
  parsedScenario.observabilityRequired = false
  await fs.writeFile(fixtureScenario, `${JSON.stringify(parsedScenario)}\n`)
  return await runHeadlessHarnessPromise({
    ref: "HEAD",
    scenarioPath: fixtureScenario,
    model: "harness/scripted",
    agent: "finny",
    outputDir: output,
    repository: root,
    ...(source === "test_current_checkout" ? { testOnlyUseCurrentSource: true } : {}),
    fixtureMode: mode,
    timeoutMs: 240_000,
  })
}

async function bundleText(bundle: string): Promise<string> {
  const chunks: string[] = []
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else chunks.push(await fs.readFile(file, "utf8"))
    }
  }
  await walk(bundle)
  return chunks.join("\n")
}

async function completionEvent(bundle: string) {
  const raw = await fs.readFile(path.join(bundle, "raw", "events.jsonl"), "utf8")
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .find((event) => event.type === "harness_completion")
}

// @codescene(disable-all) This test intentionally covers the full isolated CLI contract.
describe.skipIf(!enabled)("real CLI scripted fixture contract", () => {
  test("parallel negative runs exit zero, isolate state, match semantic hashes, and contain no secrets", async () => {
    const prior = process.env.OPENAI_API_KEY
    const secret = "sk-headless-e2e-secret-must-not-appear"
    process.env.OPENAI_API_KEY = secret
    try {
      const [left, right] = await Promise.all([run("negative", "detached"), run("negative")])
      for (const result of [left, right]) {
        expect(result.exitCode).toBe(0)
        expect(result.manifest.status).toBe("completed")
        expect(result.manifest.requestAdherence.violations).toEqual([])
        expect(Object.values(result.manifest.stages).every((status) => status === "completed")).toBe(true)
        expect(result.manifest.strategyResults.some((item) => item.unifiedVerdict === "failed")).toBe(true)
        const text = await bundleText(result.bundlePath)
        expect(text).not.toContain(secret)
        expect(text).toContain("finny.run.completed")
        expect(text).toContain(result.manifest.source.commit)
        expect(result.manifest.model.scriptSha256).toHaveLength(64)
        expect(result.manifest.source.evaluatorEntrypointSha256).toHaveLength(64)
        const bundledScenario = (
          await fs.readFile(path.join(result.bundlePath, "inputs", "scenario.json"), "utf8")
        ).trim()
        expect(sha256Bytes(bundledScenario)).toBe(result.manifest.source.scenarioSha256)
        const artifactIndex = JSON.parse(
          await fs.readFile(path.join(result.bundlePath, "artifact-index.json"), "utf8"),
        ) as {
          includedFiles: number
          includedBytes: number
          excluded: Record<string, { entries: number; bytes: number }>
          files: Array<{ source: string }>
        }
        expect(artifactIndex.includedFiles).toBeLessThan(100)
        expect(artifactIndex.includedBytes).toBeLessThan(32 * 1024 * 1024)
        expect(artifactIndex.excluded.runtime_directory.entries).toBeGreaterThan(0)
        expect(
          artifactIndex.files.some((item) =>
            /(?:^|\/)(?:\.venv|node_modules|__pycache__|site-packages)(?:\/|$)|\.(?:pyc|so|dylib)$/i.test(item.source),
          ),
        ).toBe(false)
        const completion = await completionEvent(result.bundlePath)
        expect(completion?.name).toBe("finny.run.completed")
        expect(completion?.attributes).toMatchObject({
          "finny.run_id": result.manifest.runId,
          "git.commit": result.manifest.source.commit,
          "openinference.project.name": result.manifest.isolation.phoenixProject,
          "session.id": result.manifest.sessions.main,
          session_id: result.manifest.sessions.main,
          "finny.main_session_id": result.manifest.sessions.main,
        })
      }
      expect(left.manifest.runId).not.toBe(right.manifest.runId)
      expect(left.manifest.source.preparation).toBe("detached_worktree_frozen_install")
      expect(left.manifest.attempts.find((attempt) => attempt.phase === "preflight")).toMatchObject({
        status: "completed",
        exitCode: 0,
      })
      expect(right.manifest.source.preparation).toBe("test_current_checkout")
      expect(left.manifest.isolation.namespace).not.toBe(right.manifest.isolation.namespace)
      expect(left.manifest.isolation.phoenixProject).not.toBe(right.manifest.isolation.phoenixProject)
      expect(left.manifest.sessions.main).not.toBe(right.manifest.sessions.main)
      expect(
        new Set([...Object.values(left.manifest.isolation.ports), ...Object.values(right.manifest.isolation.ports)])
          .size,
      ).toBe(Object.keys(left.manifest.isolation.ports).length + Object.keys(right.manifest.isolation.ports).length)
      expect(left.manifest.semanticHashes.source).toBe(right.manifest.semanticHashes.source)
      expect(left.manifest.semanticHashes.fixtureData).toBe(right.manifest.semanticHashes.fixtureData)
      expect(left.manifest.semanticHashes.contract).toBe(right.manifest.semanticHashes.contract)
      expect(left.manifest.semanticHashes.strategyResults).toBe(right.manifest.semanticHashes.strategyResults)
      expect(left.manifest.semanticHashes.normalizedEvents).toBe(right.manifest.semanticHashes.normalizedEvents)
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prior
    }
  }, 280_000)

  test("mid-stream model failure is runtime exit 4", async () => {
    const result = await run("midstream_failure")
    expect(result.exitCode).toBe(4)
    expect(result.manifest.status).toBe("execution_failed")
    expect(result.manifest.model.requestCount).toBeGreaterThan(0)
  }, 90_000)

  test("strategy-family drift is contract exit 2 after the real workflow", async () => {
    const result = await run("strategy_drift")
    expect(result.exitCode).toBe(2)
    expect(result.manifest.status).toBe("contract_failed")
    expect(result.manifest.requestAdherence.violations.map((item) => item.code)).toContain("strategy_family_drift")
  }, 180_000)
})
