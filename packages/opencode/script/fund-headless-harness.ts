#!/usr/bin/env bun
import path from "node:path"
import { parseArgs } from "node:util"
import { runFundScenarioFiles } from "./headless/fund-scenario"

export * from "./headless/fund-scenario"

if (import.meta.main) {
  const parsed = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      scenario: { type: "string" },
      trace: { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  })
  if (!parsed.values.scenario || !parsed.values.trace) {
    process.stderr.write("--scenario and --trace are required\n")
    process.exit(3)
  }
  const manifest = await runFundScenarioFiles({
    scenarioPath: path.resolve(parsed.values.scenario),
    tracePath: path.resolve(parsed.values.trace),
    outputPath: parsed.values.output ? path.resolve(parsed.values.output) : undefined,
  })
  if (!parsed.values.output) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  process.exit(manifest.exitCode)
}
