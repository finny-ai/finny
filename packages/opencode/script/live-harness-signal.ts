#!/usr/bin/env bun
import fs from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadScenario } from "./headless/scenario"
import { CROSSOVER_SCENARIO } from "./headless/fixtures"
import { RunManifestV1, type HeadlessScenarioV1, type RunManifestV1 as RunManifest } from "./headless/types"

const SUPPORTED_MODEL_PROVIDERS = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const

type LiveLimits = {
  wallTimeMs: number
  modelTurns: number
  toolCalls: number
  subagents: number
  maxAlgorithms: number
  maxVersionsPerAlgorithm: number
  maxBacktests: number
}

const LIVE_CEILINGS: LiveLimits = {
  wallTimeMs: 1_200_000,
  modelTurns: 40,
  toolCalls: 50,
  subagents: 4,
  maxAlgorithms: 1,
  maxVersionsPerAlgorithm: 1,
  maxBacktests: 1,
} as const

export type LivePreflight = {
  schemaVersion: "1.0.0"
  ready: boolean
  classification: "ready" | "configuration_failure"
  eventName: string
  model: { id: string; providerId: string }
  providers: { model: string; marketData: "alpaca" }
  credentialPresence: Array<{ name: string; present: boolean }>
  limits: LiveLimits
  failures: Array<{ code: string; message: string }>
}

function modelProvider(model: string): string {
  return model.split("/", 1)[0] ?? ""
}

function scenarioLimitFailures(scenario: HeadlessScenarioV1): LivePreflight["failures"] {
  const observed = {
    ...scenario.limits,
    maxAlgorithms: scenario.artifactPolicy.maxAlgorithms,
    maxVersionsPerAlgorithm: scenario.artifactPolicy.maxVersionsPerAlgorithm,
    maxBacktests: scenario.artifactPolicy.maxBacktests,
  }
  return Object.entries(LIVE_CEILINGS).flatMap(([name, ceiling]) => {
    const value = observed[name as keyof typeof observed]
    return value <= ceiling
      ? []
      : [{ code: "limit_exceeds_ceiling", message: `${name} is ${value}; live ceiling is ${ceiling}.` }]
  })
}

export function inspectLivePreflight(input: {
  eventName: string
  enabled: string
  model: string
  scenario: HeadlessScenarioV1
  env: Record<string, string | undefined>
}): LivePreflight {
  const providerId = modelProvider(input.model)
  const modelCredential = SUPPORTED_MODEL_PROVIDERS[providerId as keyof typeof SUPPORTED_MODEL_PROVIDERS]
  const requiredCredentials = [
    ...(modelCredential ? [modelCredential] : []),
    "ALPACA_API_KEY_ID",
    "ALPACA_API_SECRET_KEY",
  ]
  const credentialPresence = requiredCredentials.map((name) => ({ name, present: Boolean(input.env[name]) }))
  const failures: LivePreflight["failures"] = [
    ...(input.enabled === "1"
      ? []
      : [{ code: "live_harness_disabled", message: "Set FINNY_LIVE_HARNESS_ENABLED to 1 intentionally." }]),
    ...(input.model
      ? []
      : [{ code: "model_missing", message: "Set FINNY_HARNESS_MODEL to an explicitly supported provider/model." }]),
    ...(input.model && !modelCredential
      ? [
          {
            code: "model_provider_unsupported",
            message: `Model provider ${providerId || "<missing>"} is not wired for this workflow.`,
          },
        ]
      : []),
    ...credentialPresence
      .filter((item) => !item.present)
      .map((item) => ({
        code: "credential_missing",
        message: `Required secret ${item.name} is not configured.`,
      })),
    ...scenarioLimitFailures(input.scenario),
  ]
  return {
    schemaVersion: "1.0.0",
    ready: failures.length === 0,
    classification: failures.length === 0 ? "ready" : "configuration_failure",
    eventName: input.eventName,
    model: { id: input.model, providerId },
    providers: { model: providerId, marketData: "alpaca" },
    credentialPresence,
    limits: LIVE_CEILINGS,
    failures,
  }
}

export type LiveSignalClassification =
  | "success"
  | "configuration_failure"
  | "model_provider_failure"
  | "market_data_provider_failure"
  | "harness_contract_failure"
  | "evidence_failure"
  | "timeout"
  | "execution_failure"

type LiveUsage = {
  modelTurns: number
  toolCalls: number
  subagents: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  estimatedCostUsd?: number
  costAvailable: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function finiteNonnegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

export function collectLiveUsage(events: Array<Record<string, unknown>>, manifest: RunManifest): LiveUsage {
  const usage: LiveUsage = {
    modelTurns: 0,
    toolCalls: 0,
    subagents: manifest.sessions.subagents.length,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    costAvailable: false,
  }
  let cost = 0
  for (const event of events) {
    if (event.type === "tool_use") usage.toolCalls++
    if (event.type !== "step_finish") continue
    usage.modelTurns++
    const part = record(event.part)
    const tokens = record(part.tokens)
    const cache = record(tokens.cache)
    usage.tokens.input += finiteNonnegative(tokens.input)
    usage.tokens.output += finiteNonnegative(tokens.output)
    usage.tokens.reasoning += finiteNonnegative(tokens.reasoning)
    usage.tokens.cacheRead += finiteNonnegative(cache.read)
    usage.tokens.cacheWrite += finiteNonnegative(cache.write)
    if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) {
      cost += part.cost
      usage.costAvailable = true
    }
  }
  if (usage.costAvailable) usage.estimatedCostUsd = cost
  return usage
}

export function classifyLiveSignal(manifest: RunManifest): LiveSignalClassification {
  if (manifest.status === "completed" || manifest.status === "completed_with_recoveries") return "success"
  if (manifest.status === "preflight_failed") return "configuration_failure"
  if (manifest.status === "contract_failed") return "harness_contract_failure"
  if (manifest.status === "evidence_invalid") return "evidence_failure"
  if (manifest.status === "timed_out") return "timeout"
  const failureText = manifest.errors
    .map((error) => `${error.kind} ${error.message}`)
    .join("\n")
    .toLowerCase()
  if (/\balpaca\b|market data|historical data|candle|bars provider/.test(failureText))
    return "market_data_provider_failure"
  if (/model|openai|openrouter|rate.?limit|quota|authentication|api key|provider/.test(failureText))
    return "model_provider_failure"
  return "execution_failure"
}

function preflightMarkdown(result: LivePreflight): string {
  const lines = [
    "# Live harness preflight",
    "",
    `- Classification: ${result.classification}`,
    `- Model: ${result.model.id || "not configured"}`,
    `- Model provider: ${result.model.providerId || "not configured"}`,
    "- Market-data provider: alpaca",
    `- Configuration ready: ${result.ready}`,
    "",
  ]
  if (result.failures.length) {
    lines.push("## Required setup", "")
    for (const failure of result.failures) lines.push(`- ${failure.code}: ${failure.message}`)
    lines.push("")
  }
  return lines.join("\n")
}

function signalMarkdown(input: {
  classification: LiveSignalClassification
  manifest: RunManifest
  usage: LiveUsage
  limits: LiveLimits
}): string {
  const { manifest, usage, limits } = input
  const providerId = modelProvider(manifest.model.id)
  return [
    "# Live harness signal",
    "",
    `- Classification: ${input.classification}`,
    `- Commit: ${manifest.source.commit}`,
    `- Model: ${manifest.model.id}`,
    `- Providers: ${providerId} model / alpaca market data`,
    `- Scenario hash: ${manifest.source.scenarioSha256}`,
    `- Request-adherence violations: ${manifest.requestAdherence.violations.length}`,
    `- Terminal verdict: ${manifest.status}`,
    `- Telemetry grade: ${manifest.observability.grade}`,
    `- Usage: ${usage.modelTurns}/${limits.modelTurns} model turns; ${usage.toolCalls}/${limits.toolCalls} tool calls; ${usage.subagents}/${limits.subagents} subagents`,
    `- Tokens: ${usage.tokens.input} input; ${usage.tokens.output} output; ${usage.tokens.reasoning} reasoning`,
    `- Estimated model cost: ${usage.costAvailable ? `$${usage.estimatedCostUsd?.toFixed(6)}` : "unavailable"}`,
    "",
  ].join("\n")
}

async function append(file: string | undefined, text: string): Promise<void> {
  if (file) await fs.appendFile(file, `${text}\n`)
}

async function setOutput(file: string | undefined, name: string, value: string): Promise<void> {
  if (file) await fs.appendFile(file, `${name}=${value}\n`)
}

async function findManifest(bundleRoot: string): Promise<{ file: string; directory: string }> {
  const direct = path.join(bundleRoot, "run-manifest.json")
  if (
    await fs
      .stat(direct)
      .then((stat) => stat.isFile())
      .catch(() => false)
  )
    return { file: direct, directory: bundleRoot }
  const candidates = await fs.readdir(bundleRoot, { withFileTypes: true }).catch(() => [])
  for (const candidate of candidates.sort((a, b) => b.name.localeCompare(a.name))) {
    if (!candidate.isDirectory() || candidate.name.startsWith(".")) continue
    const nested = path.join(bundleRoot, candidate.name, "run-manifest.json")
    if (
      await fs
        .stat(nested)
        .then((stat) => stat.isFile())
        .catch(() => false)
    )
      return { file: nested, directory: path.dirname(nested) }
  }
  throw new Error(`No run-manifest.json found under ${bundleRoot}`)
}

async function main(): Promise<void> {
  const command = Bun.argv[2]
  const parsed = parseArgs({
    args: Bun.argv.slice(3),
    options: {
      scenario: { type: "string" },
      output: { type: "string" },
      bundle: { type: "string" },
    },
    strict: true,
  })
  if (command === "preflight") {
    if (!parsed.values.output) throw new Error("preflight requires --output")
    const scenario = parsed.values.scenario
      ? await loadScenario(path.resolve(parsed.values.scenario))
      : CROSSOVER_SCENARIO
    const result = inspectLivePreflight({
      eventName: process.env.GITHUB_EVENT_NAME ?? "local",
      enabled: process.env.FINNY_LIVE_HARNESS_ENABLED ?? "",
      model: process.env.FINNY_HARNESS_MODEL ?? "",
      scenario,
      env: process.env,
    })
    await fs.mkdir(path.dirname(path.resolve(parsed.values.output)), { recursive: true })
    await fs.writeFile(path.resolve(parsed.values.output), `${JSON.stringify(result, null, 2)}\n`)
    await append(process.env.GITHUB_STEP_SUMMARY, preflightMarkdown(result))
    await setOutput(process.env.GITHUB_OUTPUT, "ready", String(result.ready))
    await setOutput(process.env.GITHUB_OUTPUT, "model_provider", result.model.providerId)
    process.stdout.write(preflightMarkdown(result))
    if (!result.ready) process.exitCode = 3
    return
  }
  if (command === "summarize") {
    if (!parsed.values.bundle || !parsed.values.output) throw new Error("summarize requires --bundle and --output")
    const found = await findManifest(parsed.values.bundle)
    const manifest = RunManifestV1.parse(JSON.parse(await fs.readFile(found.file, "utf8")))
    const scenario = parsed.values.scenario
      ? await loadScenario(path.resolve(parsed.values.scenario))
      : CROSSOVER_SCENARIO
    const events = (await fs.readFile(path.join(found.directory, "raw", "events.jsonl"), "utf8"))
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.trim().startsWith("{")) return []
        try {
          const value = JSON.parse(line)
          return value && typeof value === "object" ? [value as Record<string, unknown>] : []
        } catch {
          return []
        }
      })
    const usage = collectLiveUsage(events, manifest)
    const classification = classifyLiveSignal(manifest)
    const limits = {
      ...scenario.limits,
      maxAlgorithms: scenario.artifactPolicy.maxAlgorithms,
      maxVersionsPerAlgorithm: scenario.artifactPolicy.maxVersionsPerAlgorithm,
      maxBacktests: scenario.artifactPolicy.maxBacktests,
    }
    const providerId = modelProvider(manifest.model.id)
    const signal = {
      schemaVersion: "1.0.0",
      classification,
      commit: manifest.source.commit,
      model: manifest.model,
      providers: { model: { id: providerId }, marketData: { id: "alpaca", mode: "live" } },
      scenarioSha256: manifest.source.scenarioSha256,
      requestAdherence: manifest.requestAdherence,
      terminalVerdict: manifest.status,
      telemetryGrade: manifest.observability.grade,
      limits,
      usage,
      runId: manifest.runId,
    }
    await fs.mkdir(path.dirname(path.resolve(parsed.values.output)), { recursive: true })
    await fs.writeFile(path.resolve(parsed.values.output), `${JSON.stringify(signal, null, 2)}\n`)
    await append(process.env.GITHUB_STEP_SUMMARY, signalMarkdown({ classification, manifest, usage, limits }))
    await setOutput(process.env.GITHUB_OUTPUT, "classification", classification)
    process.stdout.write(signalMarkdown({ classification, manifest, usage, limits }))
    return
  }
  throw new Error("command must be preflight or summarize")
}

if (import.meta.main) await main()
