import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import {
  createBundleWriter,
  hashTree,
  publishBundle,
  sha256Bytes,
  sha256File,
  writeBundleText,
  type BundleWriter,
} from "./artifacts"
import { startFixtureMarketDataProvider, type FixtureMarketDataProvider } from "./fixture-market-data"
import { startScriptedModelServer, type ScriptedModelServer } from "./fixture-model"
import { configureCollector, createIsolation } from "./isolation"
import { runCommand } from "./process"
import {
  bindObservedStrictRuns,
  collectFinnyArtifacts,
  inspectStrategyResults,
  type HarnessIntegrityIssue,
} from "./run-artifacts"
import { canonicalScenarioJson, loadScenario, scenarioSha256 as hashScenario } from "./scenario"
import { semanticHash } from "./semantic-hash"
import { classifyOutcome, observeRun, parseJsonEvents } from "./semantic-verdict"
import type { HeadlessHarnessOptions, HeadlessHarnessResult, HeadlessScenarioV1, RunManifestV1 } from "./types"

function runId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)
  return `${stamp}-${crypto.randomBytes(5).toString("hex")}`
}

async function commandVersion(input: {
  command: string
  args: string[]
  cwd: string
}): Promise<string | undefined> {
  const result = await runCommand({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    timeoutMs: 10_000,
  })
  if (result.exitCode !== 0) return
  return result.stdout.trim() || result.stderr.trim() || undefined
}

async function missingDependencies(input: { source: string; required: string[] }): Promise<string[]> {
  const root = path.resolve(input.source)
  const missing: string[] = []
  for (const relative of input.required) {
    const candidate = path.resolve(input.source, relative)
    if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root) {
      throw new Error(`dependency probe escapes source root: ${relative}`)
    }
    try {
      await fs.access(candidate)
    } catch {
      missing.push(relative)
    }
  }
  return missing
}

function redactSecrets(input: { text: string; values: string[] }): string {
  return input.values
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.replaceAll(secret, "<redacted>"), input.text)
}

function secretValuesFromEnv(): string[] {
  return Object.keys(process.env)
    .filter((key) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
    .map((key) => process.env[key] ?? "")
    .filter((value) => value.length >= 8)
}

type Isolation = Awaited<ReturnType<typeof createIsolation>>

type RunContext = {
  options: HeadlessHarnessOptions
  started: Date
  id: string
  scenario: HeadlessScenarioV1
  repository: string
  writer: BundleWriter
  scenarioSha256: string
  isolation: Isolation
  attempts: RunManifestV1["attempts"]
  errors: RunManifestV1["errors"]
  secretValues: string[]
  sourceAdded: boolean
  preflightFailed: boolean
  executionExit: number
  timedOut: boolean
  stdout: string
  stderr: string
  commit: string
  targetTreeHash: string
  bunLockSha256: string
  evaluatorSourceSha256: string
  evaluatorEntrypointSha256: string
  evaluatorFixtureScriptSha256: string
  cleanupStatus: "completed" | "failed"
  scriptedModel?: ScriptedModelServer
  fixtureMarketData?: FixtureMarketDataProvider
  effectiveModel: string
}

async function resolveCommit(ctx: RunContext): Promise<void> {
  const resolve = await runCommand({
    command: "git",
    args: ["rev-parse", ctx.options.ref],
    cwd: ctx.repository,
    timeoutMs: 30_000,
  })
  if (resolve.exitCode !== 0) throw new Error(`could not resolve ref ${ctx.options.ref}: ${resolve.stderr.trim()}`)
  ctx.commit = resolve.stdout.trim()
  ctx.isolation.env.FINNY_GIT_COMMIT = ctx.commit
  const targetTree = await runCommand({
    command: "git",
    args: ["rev-parse", `${ctx.commit}^{tree}`],
    cwd: ctx.repository,
    timeoutMs: 30_000,
  })
  if (targetTree.exitCode !== 0) throw new Error(`could not resolve target tree: ${targetTree.stderr.trim()}`)
  ctx.targetTreeHash = targetTree.stdout.trim()
}

async function hashEvaluatorSources(ctx: RunContext): Promise<void> {
  const evaluatorSource = path.resolve(import.meta.dir)
  ctx.evaluatorSourceSha256 = await hashTree({ root: evaluatorSource })
  ctx.evaluatorEntrypointSha256 = await sha256File({
    file: path.join(evaluatorSource, "..", "headless-harness.ts"),
  })
  ctx.evaluatorFixtureScriptSha256 = await sha256File({
    file: path.join(evaluatorSource, "fixture-model.ts"),
  })
}

async function addDetachedWorktree(ctx: RunContext): Promise<void> {
  const add = await runCommand({
    command: "git",
    args: ["worktree", "add", "--detach", ctx.isolation.source, ctx.commit],
    cwd: ctx.repository,
    timeoutMs: 120_000,
  })
  ctx.sourceAdded = add.exitCode === 0
  if (ctx.sourceAdded) return
  ctx.preflightFailed = true
  ctx.errors.push({ kind: "worktree", message: add.stderr.trim() || add.stdout.trim() })
}

async function frozenInstall(ctx: RunContext): Promise<{ exit?: number; error?: string }> {
  if (!ctx.sourceAdded) return {}
  ctx.bunLockSha256 = await sha256File({ file: path.join(ctx.isolation.source, "bun.lock") })
  const install = await runCommand({
    command: "bun",
    args: ["install", "--frozen-lockfile"],
    cwd: ctx.isolation.source,
    env: ctx.isolation.env,
    inheritEnv: false,
    timeoutMs: 300_000,
  })
  if (install.exitCode === 0) return { exit: 0 }
  const error = install.stderr.trim() || install.stdout.trim() || "frozen install failed"
  ctx.preflightFailed = true
  ctx.errors.push({ kind: "dependency_preflight", message: error })
  return { exit: install.exitCode, error }
}

function recordPreflightAttempt(
  ctx: RunContext,
  startedAt: Date,
  install: { exit?: number; error?: string },
): void {
  ctx.attempts.push({
    index: 1,
    phase: "preflight",
    status: ctx.preflightFailed ? "failed" : "completed",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ...(install.exit !== undefined ? { exitCode: install.exit } : {}),
    ...(install.error ? { error: install.error } : {}),
  })
}

async function runDetachedPreflight(ctx: RunContext): Promise<void> {
  const preflightStarted = new Date()
  await addDetachedWorktree(ctx)
  const install = await frozenInstall(ctx)
  recordPreflightAttempt(ctx, preflightStarted, install)
}

async function runCurrentSourcePreflight(ctx: RunContext): Promise<void> {
  ctx.isolation.source = ctx.repository
  ctx.bunLockSha256 = await sha256File({ file: path.join(ctx.repository, "bun.lock") })
  ctx.attempts.push({
    index: 1,
    phase: "preflight",
    status: "completed",
    startedAt: ctx.started.toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: 0,
  })
}

async function enforceRequiredDependencies(ctx: RunContext): Promise<void> {
  if (ctx.preflightFailed || !ctx.options.requiredDependencyPaths?.length) return
  const missing = await missingDependencies({
    source: ctx.isolation.source,
    required: ctx.options.requiredDependencyPaths,
  })
  if (missing.length === 0) return
  ctx.preflightFailed = true
  const message = `missing required dependencies: ${missing.join(", ")}`
  ctx.errors.push({ kind: "dependency_preflight", message })
  const preflight = ctx.attempts.find((attempt) => attempt.phase === "preflight")
  if (!preflight) return
  preflight.status = "failed"
  preflight.exitCode = 1
  preflight.error = message
}

async function startFixtures(ctx: RunContext): Promise<void> {
  if (ctx.preflightFailed || !ctx.options.fixtureMode) return
  for (const credential of ctx.isolation.credentialPresence) delete ctx.isolation.env[credential.name]
  ctx.isolation.credentialPresence.splice(0)
  ctx.fixtureMarketData = await startFixtureMarketDataProvider({
    port: ctx.isolation.ports.fixtureMarketData,
    allowedRoot: ctx.isolation.finnyHome,
    fixtureRoot: path.join(ctx.isolation.root, "fixture-market"),
    harnessMode: true,
  })
  ctx.scriptedModel = await startScriptedModelServer({
    port: ctx.isolation.ports.scriptedModel,
    mode: ctx.options.fixtureMode,
    harnessMode: true,
  })
  ctx.isolation.env.OPENCODE_CONFIG_CONTENT = ctx.scriptedModel.configContent
  ctx.isolation.env.FINNY_HARNESS_MARKET_DATA_URL = ctx.fixtureMarketData.url
  ctx.isolation.env.FINNY_HARNESS_MARKET_DATA_CSV = ctx.fixtureMarketData.csvPath
  ctx.isolation.env.FINNY_HARNESS_MARKET_DATA_SHA256 = ctx.fixtureMarketData.csvSha256
  ctx.isolation.env.FINNY_HARNESS_FIXTURE_MARKET_DATA = "1"
  ctx.isolation.env.FINNY_HARNESS_SCRIPTED_MODEL = "1"
  ctx.effectiveModel = ctx.scriptedModel.model
}

async function runExecution(ctx: RunContext): Promise<void> {
  if (ctx.preflightFailed) return
  const executionStarted = new Date()
  const opencode = path.join(ctx.isolation.source, "packages", "opencode")
  const execution = await runCommand({
    command: "bun",
    args: [
      "run",
      "--conditions=browser",
      "src/index.ts",
      "run",
      "--format",
      "json",
      "--agent",
      ctx.options.agent,
      "--model",
      ctx.effectiveModel,
      "--dir",
      ctx.isolation.source,
      "--port",
      String(ctx.isolation.ports.http),
      ctx.scenario.prompt,
    ],
    cwd: opencode,
    env: ctx.isolation.env,
    inheritEnv: false,
    timeoutMs: ctx.options.timeoutMs ?? ctx.scenario.limits.wallTimeMs,
  })
  ctx.executionExit = execution.exitCode
  ctx.timedOut = execution.timedOut
  ctx.stdout = execution.stdout
  ctx.stderr = execution.stderr
  ctx.attempts.push({
    index: ctx.attempts.length + 1,
    phase: "execution",
    status: ctx.timedOut ? "timed_out" : execution.exitCode === 0 ? "completed" : "failed",
    startedAt: executionStarted.toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: execution.exitCode,
    ...(execution.exitCode !== 0 ? { error: execution.stderr.trim().slice(0, 2_000) } : {}),
  })
}

async function stopFixtures(ctx: RunContext): Promise<void> {
  await ctx.scriptedModel?.stop().catch(() => {})
  await ctx.fixtureMarketData?.stop().catch(() => {})
}

async function writeRawOutputs(ctx: RunContext): Promise<void> {
  ctx.stdout = redactSecrets({ text: ctx.stdout, values: ctx.secretValues })
  ctx.stderr = redactSecrets({ text: ctx.stderr, values: ctx.secretValues })
  await writeBundleText({ writer: ctx.writer, relative: "raw/stdout.log", content: ctx.stdout })
  await writeBundleText({ writer: ctx.writer, relative: "raw/stderr.log", content: ctx.stderr })
  await writeBundleText({ writer: ctx.writer, relative: "raw/events.jsonl", content: ctx.stdout })
  if (!ctx.scriptedModel) return
  await writeBundleText({
    writer: ctx.writer,
    relative: "raw/fixture-model-requests.json",
    content: `${JSON.stringify(
      {
        count: ctx.scriptedModel.requests(),
        paths: ctx.scriptedModel.requestBodies().map((body) => ({ model: body.model, stream: body.stream })),
      },
      null,
      2,
    )}\n`,
  })
}

async function collectEvidence(ctx: RunContext): Promise<{
  integrityIssues: HarnessIntegrityIssue[]
  observation: ReturnType<typeof observeRun>
  strategyResults: Array<Record<string, unknown>>
  outcome: ReturnType<typeof classifyOutcome>
}> {
  const collectedArtifacts = await collectFinnyArtifacts({
    writer: ctx.writer,
    finnyHome: ctx.isolation.finnyHome,
    secretValues: ctx.secretValues,
  })
  await writeBundleText({
    writer: ctx.writer,
    relative: "artifact-index.json",
    content: `${JSON.stringify(
      { schemaVersion: "1.0.0", ...collectedArtifacts.capture, files: collectedArtifacts.index },
      null,
      2,
    )}\n`,
  })
  const inspectedRuns = await inspectStrategyResults(ctx.isolation.finnyHome)
  const integrityIssues: HarnessIntegrityIssue[] = [...collectedArtifacts.issues, ...inspectedRuns.issues]
  const observabilityAvailable = false
  if (ctx.scenario.observabilityRequired && !observabilityAvailable) {
    integrityIssues.push({
      kind: "artifact_integrity",
      message: "scenario requires observability grading, but no collector/trace grader is available",
    })
  }

  const events = parseJsonEvents(ctx.stdout)
  const observation = observeRun(events, ctx.scenario)
  integrityIssues.push(
    ...bindObservedStrictRuns({
      finnyHome: ctx.isolation.finnyHome,
      savedCandidates: observation.savedCandidates,
      backtests: observation.backtestRuns,
      runs: inspectedRuns.runs,
      scenario: ctx.scenario.request,
    }),
  )
  const outcome = classifyOutcome({
    preflightFailed: ctx.preflightFailed,
    timedOut: ctx.timedOut,
    childExitCode: ctx.executionExit,
    observation,
    observabilityRequired: ctx.scenario.observabilityRequired,
    observabilityAvailable,
    integrityErrors: integrityIssues.map((issue) => issue.message),
  })
  return { integrityIssues, observation, strategyResults: inspectedRuns.results, outcome }
}

async function removeWorktree(ctx: RunContext): Promise<void> {
  if (!ctx.sourceAdded) return
  const remove = await runCommand({
    command: "git",
    args: ["worktree", "remove", "--force", ctx.isolation.source],
    cwd: ctx.repository,
    timeoutMs: 120_000,
  })
  if (remove.exitCode !== 0) ctx.cleanupStatus = "failed"
  else ctx.sourceAdded = false
}

function emptyObservability(ctx: RunContext, mainSession?: string): RunManifestV1["observability"] {
  return {
    required: ctx.scenario.observabilityRequired,
    project: ctx.isolation.phoenixProject,
    ...(mainSession ? { sessionId: mainSession } : {}),
    traceIds: [],
    spanCount: 0,
    unattributedSpanCount: 0,
    paginationComplete: false,
    completionSpanFound: false,
    flush: "not_run",
    grade: "not_run",
  }
}

function modelSection(ctx: RunContext): RunManifestV1["model"] {
  return {
    id: ctx.effectiveModel,
    agent: ctx.options.agent,
    ...(ctx.options.fixtureMode
      ? {
          fixtureMode: ctx.options.fixtureMode,
          requestCount: ctx.scriptedModel?.requests() ?? 0,
          configSha256: sha256Bytes(ctx.scriptedModel?.configContent ?? ""),
          scriptSha256: ctx.evaluatorFixtureScriptSha256,
        }
      : {}),
  }
}

function isolationSection(ctx: RunContext): RunManifestV1["isolation"] {
  return {
    namespace: ctx.id,
    reusedState: false,
    finnyHome: "isolated/finny-home",
    database: "isolated/db/opencode.db",
    xdgData: "isolated/xdg/data",
    xdgState: "isolated/xdg/state",
    xdgCache: "isolated/xdg/cache",
    xdgConfig: "isolated/xdg/config",
    phoenixProject: ctx.isolation.phoenixProject,
    ports: ctx.isolation.ports,
    cleanupStatus: ctx.cleanupStatus,
  }
}

function sourceSection(ctx: RunContext): RunManifestV1["source"] {
  return {
    ref: ctx.options.ref,
    commit: ctx.commit,
    targetTreeHash: ctx.targetTreeHash,
    treeState: "clean",
    preparation: ctx.options.testOnlyUseCurrentSource ? "test_current_checkout" : "detached_worktree_frozen_install",
    bunLockSha256: ctx.bunLockSha256,
    evaluatorSourceSha256: ctx.evaluatorSourceSha256,
    evaluatorEntrypointSha256: ctx.evaluatorEntrypointSha256,
    scenarioSha256: ctx.scenarioSha256,
  }
}

function semanticHashes(
  ctx: RunContext,
  input: {
    events: unknown
    stages: unknown
    violations: unknown
    recoveries?: unknown
    strategyResults: unknown
  },
): RunManifestV1["semanticHashes"] {
  return {
    source: semanticHash({
      commit: ctx.commit,
      targetTreeHash: ctx.targetTreeHash,
      bunLockSha256: ctx.bunLockSha256,
      evaluatorSourceSha256: ctx.evaluatorSourceSha256,
      evaluatorEntrypointSha256: ctx.evaluatorEntrypointSha256,
      scenarioSha256: ctx.scenarioSha256,
    }),
    ...(ctx.fixtureMarketData ? { fixtureData: ctx.fixtureMarketData.csvSha256 } : {}),
    normalizedEvents: semanticHash(input.events, [ctx.id, ctx.isolation.root, ctx.isolation.source]),
    contract: semanticHash({
      scenarioSha256: ctx.scenarioSha256,
      stages: input.stages,
      violations: input.violations,
      ...(input.recoveries !== undefined ? { recoveries: input.recoveries } : {}),
    }),
    strategyResults: semanticHash(input.strategyResults, [ctx.id, ctx.isolation.root]),
  }
}

async function buildSuccessManifest(
  ctx: RunContext,
  evidence: Awaited<ReturnType<typeof collectEvidence>>,
): Promise<Omit<RunManifestV1, "artifacts" | "integrity">> {
  const finished = new Date()
  const events = parseJsonEvents(ctx.stdout)
  return {
    schemaVersion: "1.0.0",
    runId: ctx.id,
    scenarioId: ctx.scenario.id,
    status: evidence.outcome.status,
    exitCode: evidence.outcome.exitCode,
    startedAt: ctx.started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - ctx.started.getTime(),
    source: sourceSection(ctx),
    runtime: {
      os: os.platform(),
      arch: os.arch(),
      bunVersion: Bun.version,
      pythonVersion: await commandVersion({ command: "python3", args: ["--version"], cwd: ctx.repository }),
      uvVersion: await commandVersion({ command: "uv", args: ["--version"], cwd: ctx.repository }),
    },
    model: modelSection(ctx),
    isolation: isolationSection(ctx),
    attempts: ctx.attempts,
    sessions: { main: evidence.observation.mainSession, subagents: evidence.observation.subagents },
    stages: evidence.observation.stages,
    requestAdherence: {
      expected: ctx.scenario.request,
      observed: {
        algorithms: evidence.observation.algorithms,
        versionsByAlgorithm: evidence.observation.versionsByAlgorithm,
        backtests: evidence.observation.backtests,
        completedBacktests: evidence.observation.completedBacktests,
        savedCandidates: evidence.observation.savedCandidates,
        backtestRuns: evidence.observation.backtestRuns.map((run) => ({
          ...run,
          ...(run.artifactDir ? { artifactDir: path.relative(ctx.isolation.finnyHome, run.artifactDir) } : {}),
        })),
        toolCalls: evidence.observation.toolCalls,
        modelTurns: evidence.observation.modelTurns,
        requestIdentity: evidence.observation.requestIdentity,
        credentialPresence: ctx.isolation.credentialPresence,
      },
      violations: evidence.observation.violations,
    },
    strategyResults: evidence.strategyResults,
    recoveries: evidence.observation.recoveries,
    errors: [...ctx.errors, ...evidence.observation.errors, ...evidence.integrityIssues],
    observability: emptyObservability(ctx, evidence.observation.mainSession),
    semanticHashes: semanticHashes(ctx, {
      events,
      stages: evidence.observation.stages,
      violations: evidence.observation.violations,
      recoveries: evidence.observation.recoveries,
      strategyResults: evidence.strategyResults,
    }),
  }
}

async function buildErrorManifest(
  ctx: RunContext,
  message: string,
): Promise<Omit<RunManifestV1, "artifacts" | "integrity">> {
  const finished = new Date()
  const emptyObservation = observeRun([], ctx.scenario)
  const outcome = classifyOutcome({ internalError: true, observation: emptyObservation })
  return {
    schemaVersion: "1.0.0",
    runId: ctx.id,
    scenarioId: ctx.scenario.id,
    status: outcome.status,
    exitCode: outcome.exitCode,
    startedAt: ctx.started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - ctx.started.getTime(),
    source: sourceSection(ctx),
    runtime: { os: os.platform(), arch: os.arch(), bunVersion: Bun.version },
    model: {
      id: ctx.options.fixtureMode ? "harness/scripted" : ctx.options.model,
      agent: ctx.options.agent,
      ...(ctx.options.fixtureMode
        ? {
            fixtureMode: ctx.options.fixtureMode,
            requestCount: ctx.scriptedModel?.requests() ?? 0,
            configSha256: sha256Bytes(ctx.scriptedModel?.configContent ?? ""),
            scriptSha256: ctx.evaluatorFixtureScriptSha256,
          }
        : {}),
    },
    isolation: isolationSection(ctx),
    attempts: ctx.attempts,
    sessions: { subagents: [] },
    stages: emptyObservation.stages,
    requestAdherence: { expected: ctx.scenario.request, observed: {}, violations: emptyObservation.violations },
    strategyResults: [],
    recoveries: [],
    errors: [...ctx.errors, { kind: "internal_error", message }],
    observability: emptyObservability(ctx),
    semanticHashes: semanticHashes(ctx, {
      events: [],
      stages: emptyObservation.stages,
      violations: emptyObservation.violations,
      strategyResults: [],
    }),
  }
}

export function runHeadlessHarness(options: HeadlessHarnessOptions): Effect.Effect<HeadlessHarnessResult, unknown> {
  return Effect.tryPromise({
    try: () => runHeadlessHarnessPromise(options),
    catch: (error) => error,
  })
}

/** Promise adapter for the Bun CLI and black-box tests. */
export async function runHeadlessHarnessPromise(options: HeadlessHarnessOptions): Promise<HeadlessHarnessResult> {
  const started = new Date()
  const id = runId()
  const scenario = await loadScenario(options.scenarioPath)
  const repository = path.resolve(options.repository ?? path.resolve(import.meta.dir, "../../../.."))
  const writer = await createBundleWriter({ outputDir: path.resolve(options.outputDir), runId: id })
  const scenarioJson = canonicalScenarioJson(scenario)
  const scenarioSha256 = hashScenario(scenario)
  await writeBundleText({ writer, relative: "inputs/scenario.json", content: `${scenarioJson}\n` })
  const isolation = await createIsolation(id)

  const ctx: RunContext = {
    options,
    started,
    id,
    scenario,
    repository,
    writer,
    scenarioSha256,
    isolation,
    attempts: [],
    errors: [],
    secretValues: secretValuesFromEnv(),
    sourceAdded: false,
    preflightFailed: false,
    executionExit: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
    commit: "",
    targetTreeHash: "",
    bunLockSha256: sha256Bytes(""),
    evaluatorSourceSha256: sha256Bytes(""),
    evaluatorEntrypointSha256: sha256Bytes(""),
    evaluatorFixtureScriptSha256: sha256Bytes(""),
    cleanupStatus: "completed",
    effectiveModel: options.model,
  }

  try {
    configureCollector(isolation.env, options.collectorEndpoint)
    await resolveCommit(ctx)
    await hashEvaluatorSources(ctx)
    if (options.testOnlyUseCurrentSource) await runCurrentSourcePreflight(ctx)
    else await runDetachedPreflight(ctx)
    await enforceRequiredDependencies(ctx)
    await startFixtures(ctx)
    await runExecution(ctx)
    await stopFixtures(ctx)
    await writeRawOutputs(ctx)
    const evidence = await collectEvidence(ctx)
    await removeWorktree(ctx)
    const published = await publishBundle(writer, await buildSuccessManifest(ctx, evidence))
    await fs.rm(isolation.root, { recursive: true, force: true }).catch(() => {})
    return { manifest: published.manifest, bundlePath: published.bundlePath, exitCode: evidence.outcome.exitCode }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await stopFixtures(ctx)
    ctx.stdout = redactSecrets({ text: ctx.stdout, values: ctx.secretValues })
    ctx.stderr = redactSecrets({ text: `${ctx.stderr}\n${message}\n`, values: ctx.secretValues })
    await writeBundleText({ writer: ctx.writer, relative: "raw/stdout.log", content: ctx.stdout })
    await writeBundleText({ writer: ctx.writer, relative: "raw/stderr.log", content: ctx.stderr })
    await removeWorktree(ctx)
    const published = await publishBundle(writer, await buildErrorManifest(ctx, message))
    await fs.rm(isolation.root, { recursive: true, force: true }).catch(() => {})
    return { manifest: published.manifest, bundlePath: published.bundlePath, exitCode: published.manifest.exitCode }
  }
}
