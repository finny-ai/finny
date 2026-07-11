#!/usr/bin/env bun
import path from "path"
import { Process } from "../src/util/process"

type SmokeResult = {
  engineTreeSha256: string
  rawDataSha256: string
  processedDataSha256: string
  resultSha256: string
  tradesSha256: string
  pythonVersion: string
  installedPackagesSha256: string
}

function option(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function parse(output: Buffer, label: string): SmokeResult {
  const line = output
    .toString()
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .findLast((item) => item.startsWith("{"))
  if (!line) throw new Error(`${label} did not emit a smoke result`)
  return JSON.parse(line) as SmokeResult
}

async function execute(command: string[], cwd: string, label: string): Promise<SmokeResult> {
  const result = await Process.run(command, { cwd, nothrow: true, timeout: 180_000 })
  if (result.code !== 0) {
    throw new Error(
      `${label} failed (${result.code}): ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    )
  }
  return parse(result.stdout, label)
}

const packageRoot = path.resolve(import.meta.dir, "..")
const python = path.resolve(option("--python"))
const binary = path.resolve(option("--binary"))
const source = await execute(
  [process.execPath, "run", path.join(packageRoot, "src/index.ts"), "debug", "engine-smoke", "--python", python],
  packageRoot,
  "source smoke",
)
const packaged = await execute([binary, "debug", "engine-smoke", "--python", python], packageRoot, "packaged smoke")

const keys: Array<keyof SmokeResult> = [
  "engineTreeSha256",
  "rawDataSha256",
  "processedDataSha256",
  "resultSha256",
  "tradesSha256",
  "pythonVersion",
  "installedPackagesSha256",
]
const mismatches = keys.filter((key) => source[key] !== packaged[key])
if (mismatches.length > 0) {
  throw new Error(`source and packaged engine smoke differ: ${mismatches.join(", ")}`)
}

console.log(JSON.stringify({ source, packaged, semanticHashesMatch: true }, null, 2))
