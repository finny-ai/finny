#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  evaluateQualityGate,
  isQualityGateConfig,
  isQualityObservation,
  qualityReportMarkdown,
  type QualityGateConfig,
  type QualityObservation,
} from "../src/finnybench/quality-gate"
import { isTrajectory, type Trajectory } from "../src/finnybench/trajectory-grader"

interface Options {
  configPath: string
  baselinePath: string
  candidatePath: string
  reportPath?: string
  summaryPath?: string
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function required(flag: string): string {
  const value = valueAfter(flag)
  if (!value) throw new Error(`${flag} <path> is required`)
  return value
}

function options(): Options {
  return {
    configPath: valueAfter("--config") ?? "finnybench/quality-gate.json",
    baselinePath: required("--baseline"),
    candidatePath: required("--candidate"),
    reportPath: valueAfter("--report"),
    summaryPath: valueAfter("--summary"),
  }
}

async function values(path: string): Promise<unknown[]> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf8")
  if (!absolute.endsWith(".jsonl")) {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

async function config(path: string): Promise<QualityGateConfig> {
  const value: unknown = JSON.parse(await readFile(resolve(path), "utf8"))
  if (!isQualityGateConfig(value)) throw new Error("Invalid finnybench.quality-gate.v1 config")
  if (value.minimum_observations <= 0) throw new Error("minimum_observations must be positive")
  return value
}

export function qualityObservationFromTrajectory(trajectory: Trajectory): QualityObservation | undefined {
  const quality = trajectory.strategy_quality
  if (
    quality?.valid_backtest !== true ||
    quality.quality_evidence_class === undefined ||
    quality.repeat === undefined ||
    quality.strategy_sharpe === undefined ||
    quality.strategy_total_return === undefined ||
    quality.benchmark_sharpe === undefined ||
    quality.benchmark_total_return === undefined ||
    quality.exploratory_gate_passed === undefined ||
    quality.closed_trades === undefined
  )
    return undefined
  const observation = {
    schema: "finnybench.quality-observation.v1",
    task_id: trajectory.scenario_id,
    provider: trajectory.pins.provider,
    model: trajectory.pins.model,
    repeat: quality.repeat,
    pins: {
      task_sha256: trajectory.pins.prompt_sha256,
      data_snapshot_sha256: trajectory.pins.data_snapshot_sha256,
      provider_config_sha256: trajectory.pins.provider_config_sha256,
    },
    evidence_class: quality.quality_evidence_class,
    strategy: {
      sharpe: quality.strategy_sharpe,
      total_return: quality.strategy_total_return,
      exploratory_gate_passed: quality.exploratory_gate_passed,
      closed_trades: quality.closed_trades,
    },
    benchmark: {
      sharpe: quality.benchmark_sharpe,
      total_return: quality.benchmark_total_return,
    },
    promotion_eligible: false,
  } as const
  return isQualityObservation(observation) ? observation : undefined
}

async function observations(path: string): Promise<QualityObservation[]> {
  const input = await values(path)
  const normalized: Array<QualityObservation | undefined> = input.map((value) => {
    if (isQualityObservation(value)) return value
    if (isTrajectory(value)) return qualityObservationFromTrajectory(value)
    return undefined
  })
  if (normalized.some((value) => value === undefined))
    throw new Error(
      `${path} contains invalid or incomplete quality evidence; every record must be a quality observation or a valid backtest trajectory with quantitative quality fields`,
    )
  return normalized.filter((value): value is QualityObservation => value !== undefined)
}

async function main() {
  const input = options()
  const report = evaluateQualityGate({
    config: await config(input.configPath),
    baseline: await observations(input.baselinePath),
    candidate: await observations(input.candidatePath),
  })
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  const markdown = qualityReportMarkdown(report)
  if (input.reportPath) {
    const reportPath = resolve(input.reportPath)
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, serialized)
  } else process.stdout.write(serialized)
  if (input.summaryPath) {
    const summaryPath = resolve(input.summaryPath)
    await mkdir(dirname(summaryPath), { recursive: true })
    await writeFile(summaryPath, markdown)
  }
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" })
  if (report.status === "failure") process.exitCode = 1
}

if (import.meta.main)
  main().catch((error) => {
    console.error(String(error))
    process.exit(1)
  })
