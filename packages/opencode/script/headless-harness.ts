#!/usr/bin/env bun
import path from "node:path"
import { parseArgs } from "node:util"
import { runHeadlessHarnessPromise } from "./headless/orchestrator"

export { runHeadlessHarness, runHeadlessHarnessPromise } from "./headless/orchestrator"
export * from "./headless/types"
export * from "./headless/fund-scenario"

if (import.meta.main) {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      ref: { type: "string", default: "HEAD" },
      scenario: { type: "string" },
      model: { type: "string", default: process.env.FINNY_HARNESS_MODEL ?? "opencode/deepseek-v4-flash-free" },
      agent: { type: "string", default: "finny" },
      output: { type: "string" },
      timeout: { type: "string" },
      fixture: { type: "string" },
      collector: { type: "string" },
    },
    strict: true,
  })
  const repo = path.resolve(import.meta.dir, "../../..")
  const scenario = path.resolve(
    parsed.values.scenario ?? path.join(import.meta.dir, "../harness/scenarios/spy-5m-sma-crossover.v1.json"),
  )
  const output = path.resolve(parsed.values.output ?? path.join(repo, ".artifacts/headless"))
  const timeoutMs = parsed.values.timeout ? Number(parsed.values.timeout) : undefined
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    process.stderr.write("--timeout must be a positive number of milliseconds\n")
    process.exit(3)
  }
  const fixture = parsed.values.fixture
  if (fixture && !["negative", "strategy_drift", "midstream_failure", "positive_qualification"].includes(fixture)) {
    process.stderr.write("--fixture must be negative, strategy_drift, midstream_failure, or positive_qualification\n")
    process.exit(3)
  }
  const result = await runHeadlessHarnessPromise({
    ref: parsed.values.ref!,
    scenarioPath: scenario,
    model: parsed.values.model!,
    agent: parsed.values.agent!,
    outputDir: output,
    repository: repo,
    timeoutMs,
    fixtureMode: fixture as "negative" | "strategy_drift" | "midstream_failure" | "positive_qualification" | undefined,
    collectorEndpoint: parsed.values.collector,
  })
  process.stdout.write(`${result.bundlePath}\n`)
  process.exit(result.exitCode)
}
