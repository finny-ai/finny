#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadMatrixRows } from "./headless/scenario-matrix"

const parsed = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    partition: { type: "string" },
    output: { type: "string" },
  },
  strict: true,
})
const partition = parsed.values.partition
if (partition && !["workflow", "identity", "degradation"].includes(partition)) {
  throw new Error("--partition must be workflow, identity, or degradation")
}
const packageRoot = path.resolve(import.meta.dir, "..")
const output = path.resolve(parsed.values.output ?? path.join(packageRoot, "../../.artifacts/headless-matrix"))
const rows = await loadMatrixRows({
  scenariosDir: path.join(packageRoot, "harness/scenarios"),
  fixturesDir: path.join(packageRoot, "harness/fixtures"),
  partition: partition as "workflow" | "identity" | "degradation" | undefined,
})
await fs.mkdir(output, { recursive: true })
for (const row of rows) {
  await fs.writeFile(path.join(output, `${row.scenarioId}.json`), `${JSON.stringify(row, null, 2)}\n`)
}
await fs.writeFile(
  path.join(output, "index.json"),
  `${JSON.stringify({ schemaVersion: "1.0.0", partition: partition ?? "all", scenarios: rows }, null, 2)}\n`,
)
if (rows.some((row) => row.violations.length > 0)) process.exitCode = 2
