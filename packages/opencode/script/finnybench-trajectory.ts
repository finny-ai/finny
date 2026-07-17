#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  gradeTrajectory,
  isSuiteContract,
  isTrajectory,
  validateSuite,
  type SuiteContract,
  type Trajectory,
  type TrajectoryGrade,
} from "../src/finnybench/trajectory-grader"

interface Baseline {
  schema: "finnybench.trajectory-baseline.v1"
  grades: Array<
    Pick<
      TrajectoryGrade,
      | "scenario_id"
      | "provider"
      | "model"
      | "pass"
      | "terminal_pass"
      | "harness_invariants_pass"
      | "strategy_quality_pass"
      | "budget_pass"
    >
  >
}

interface Options {
  suitePath: string
  inputPath?: string
  baselinePath?: string
  requiredSubset?: "smoke" | "full"
  validateOnly: boolean
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"))
}

function isBaseline(value: unknown): value is Baseline {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    "grades" in value &&
    value.schema === "finnybench.trajectory-baseline.v1" &&
    Array.isArray(value.grades)
  )
}

function comparable(grade: TrajectoryGrade) {
  const {
    scenario_id,
    provider,
    model,
    pass,
    terminal_pass,
    harness_invariants_pass,
    strategy_quality_pass,
    budget_pass,
  } = grade
  return {
    scenario_id,
    provider,
    model,
    pass,
    terminal_pass,
    harness_invariants_pass,
    strategy_quality_pass,
    budget_pass,
  }
}

function baselineDifferences(baseline: Baseline, grades: TrajectoryGrade[]): string[] {
  const expected = new Map(
    baseline.grades.map((grade) => [`${grade.scenario_id}:${grade.provider}:${grade.model}`, grade]),
  )
  const differences: string[] = []
  for (const grade of grades) {
    const key = `${grade.scenario_id}:${grade.provider}:${grade.model}`
    const prior = expected.get(key)
    if (!prior) differences.push(`${key}: new grade requires baseline review`)
    else if (JSON.stringify(prior) !== JSON.stringify(comparable(grade)))
      differences.push(`${key}: score changed and requires baseline review`)
    expected.delete(key)
  }
  for (const key of expected.keys()) differences.push(`${key}: missing grade requires baseline review`)
  return differences
}

function coverageErrors(suite: SuiteContract, grades: TrajectoryGrade[], subset?: "smoke" | "full"): string[] {
  const scenarios = suite.scenarios.filter(
    (scenario) => !subset || scenario.subset === subset || (subset === "full" && scenario.subset === "smoke"),
  )
  const observed = new Set(grades.map((grade) => `${grade.scenario_id}:${grade.provider}`))
  return scenarios.flatMap((scenario) =>
    suite.providers
      .filter((provider) => !observed.has(`${scenario.id}:${provider.id}`))
      .map((provider) => `${scenario.id}:${provider.id}: missing provider-backed trajectory`),
  )
}

function options(): Options {
  const subsetValue = valueAfter("--require-subset")
  requireCondition(
    !subsetValue || subsetValue === "smoke" || subsetValue === "full",
    "--require-subset must be smoke or full",
  )
  return {
    suitePath: valueAfter("--suite") ?? "finnybench/trajectory-suite.json",
    inputPath: valueAfter("--input"),
    baselinePath: valueAfter("--baseline"),
    requiredSubset: subsetValue === "smoke" || subsetValue === "full" ? subsetValue : undefined,
    validateOnly: process.argv.includes("--validate-suite"),
  }
}

async function loadSuite(path: string): Promise<SuiteContract> {
  const suiteValue = await json(path)
  requireCondition(isSuiteContract(suiteValue), "Invalid trajectory suite shape")
  const suiteErrors = validateSuite(suiteValue)
  requireCondition(
    suiteErrors.length === 0,
    `Invalid trajectory suite:\n${suiteErrors.map((item) => `- ${item}`).join("\n")}`,
  )
  return suiteValue
}

async function loadTrajectories(inputPath: string): Promise<Trajectory[]> {
  const raw = await readFile(resolve(inputPath), "utf8")
  const values: unknown[] = inputPath.endsWith(".jsonl")
    ? raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [JSON.parse(raw)]
  requireCondition(values.every(isTrajectory), "Input contains an invalid finnybench.trajectory.v1 record")
  return values
}

function requireCoverage(suite: SuiteContract, grades: TrajectoryGrade[], subset?: "smoke" | "full") {
  if (!subset) return
  const missing = coverageErrors(suite, grades, subset)
  requireCondition(
    missing.length === 0,
    `Incomplete ${subset} coverage:\n${missing.map((item) => `- ${item}`).join("\n")}`,
  )
}

async function requireBaseline(path: string | undefined, grades: TrajectoryGrade[]) {
  if (!path) return
  const baseline = await json(path)
  requireCondition(isBaseline(baseline), "Invalid trajectory baseline shape")
  const differences = baselineDifferences(baseline, grades)
  requireCondition(differences.length === 0, `Baseline changed:\n${differences.map((item) => `- ${item}`).join("\n")}`)
}

async function main() {
  const input = options()
  const suite = await loadSuite(input.suitePath)
  if (input.validateOnly) {
    console.log(`validated ${suite.scenarios.length} scenarios and ${suite.providers.length} providers`)
    return
  }
  requireCondition(!!input.inputPath, "--input <trajectory.json|trajectory.jsonl> is required")
  const trajectories = await loadTrajectories(input.inputPath)
  const grades = trajectories.map((trajectory) => gradeTrajectory(suite, trajectory))
  requireCoverage(suite, grades, input.requiredSubset)
  await requireBaseline(input.baselinePath, grades)
  console.log(JSON.stringify({ schema: "finnybench.trajectory-report.v1", grades }, null, 2))
  if (grades.some((grade) => !grade.pass)) process.exitCode = 1
}

if (import.meta.main)
  main().catch((error) => {
    console.error(String(error))
    process.exit(1)
  })

export { baselineDifferences, coverageErrors }
