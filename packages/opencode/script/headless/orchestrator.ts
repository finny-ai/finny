import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
// @codescene(disable-all) The orchestrator module is the lifecycle boundary for isolated runs.
import { Effect } from "effect"
import { createBundleWriter, hashTree, publishBundle, sha256Bytes, sha256File, writeBundleText } from "./artifacts"
import { startFixtureMarketDataProvider, type FixtureMarketDataProvider } from "./fixture-market-data"
import { startScriptedModelServer, type ScriptedModelServer } from "./fixture-model"
import { configureCollector, configureTelemetryIdentity, createIsolation } from "./isolation"
import { runCommand } from "./process"
import { inspectLockedPythonRuntime, prepareLockedPythonRuntime, type LockedPythonRuntime } from "./python-runtime"
import { fetchSpans, gradeSessions, parseArgs as parsePhoenixArgs, validateGrade } from "../phoenix-trace-grader"
import {
  bindObservedStrictRuns,
  collectFinnyArtifacts,
  inspectStrategyResults,
  type HarnessIntegrityIssue,
} from "./run-artifacts"
import { canonicalScenarioJson, loadScenario, scenarioSha256 as hashScenario } from "./scenario"
import { semanticHash } from "./semantic-hash"
import { classifyOutcome, observeRun, parseJsonEvents } from "./semantic-verdict"
import type { HeadlessHarnessOptions, HeadlessHarnessResult, RunManifestV1 } from "./types"

function runId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)
  return `${stamp}-${crypto.randomBytes(5).toString("hex")}`
}

export { semanticHash } from "./semantic-hash"

export function semanticEventHash(observation: ReturnType<typeof observeRun>): string {
  return semanticHash({
    toolCalls: observation.toolCalls,
    modelTurns: observation.modelTurns,
    algorithms: observation.algorithms,
    versionsByAlgorithm: observation.versionsByAlgorithm,
    requestIdentity: observation.requestIdentity,
    stages: observation.stages,
    finalText: observation.finalText,
    recoveries: observation.recoveries,
    errors: observation.errors,
    violations: observation.violations,
  })
}

async function missingDependencies(source: string, required: string[]): Promise<string[]> {
  const missing: string[] = []
  for (const relative of required) {
    const candidate = path.resolve(source, relative)
    if (!candidate.startsWith(`${path.resolve(source)}${path.sep}`) && candidate !== path.resolve(source)) {
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

function redactSecrets(text: string, values: string[]): string {
  return values
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((current, secret) => current.replaceAll(secret, "<redacted>"), text)
}

type HarnessObservability = RunManifestV1["observability"]
type HarnessIsolation = Awaited<ReturnType<typeof createIsolation>>
type HarnessAttempt = RunManifestV1["attempts"][number]

type HarnessPreflight = {
  sourceAdded: boolean
  failed: boolean
  bunLockSha256: string
  attempt: HarnessAttempt
  errors: RunManifestV1["errors"]
  pythonRuntime?: LockedPythonRuntime
}

function telemetryFlush(events: Array<Record<string, any>>): HarnessObservability["flush"] {
  const value = events.findLast((event) => event.type === "harness_telemetry")?.flush
  return value === "completed" || value === "timed_out" || value === "failed" || value === "not_run" ? value : "not_run"
}

async function collectObservability(input: {
  required: boolean
  endpoint?: string
  project: string
  runId: string
  commit: string
  sessionId?: string
  since?: Date
  until?: Date
  flush: HarnessObservability["flush"]
}): Promise<{ observability: HarnessObservability; report: Record<string, unknown>; errors: string[] }> {
  const empty: HarnessObservability = {
    required: input.required,
    project: input.project,
    sessionId: input.sessionId,
    traceIds: [],
    spanCount: 0,
    unattributedSpanCount: 0,
    paginationComplete: false,
    completionSpanFound: false,
    flush: input.flush,
    grade: "not_run",
  }
  if (!input.required) return { observability: empty, report: { skipped: true, reason: "not_required" }, errors: [] }
  const missing = [
    !input.endpoint && "collector endpoint is not configured",
    !input.sessionId && "main session ID is missing",
    !input.since && "execution start time is missing",
    !input.until && "execution finish time is missing",
  ].filter((item): item is string => Boolean(item))
  if (missing.length > 0) {
    return {
      observability: { ...empty, grade: "invalid" },
      report: { validation: { valid: false, reasons: missing } },
      errors: missing,
    }
  }

  const args = parsePhoenixArgs([
    "--endpoint",
    input.endpoint!,
    "--project",
    input.project,
    "--session",
    input.sessionId!,
    "--run-id",
    input.runId,
    "--commit",
    input.commit,
    "--since",
    input.since!.toISOString(),
    "--until",
    input.until!.toISOString(),
    "--require-complete",
  ])
  let last: Record<string, any> | undefined
  let lastError: string | undefined
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const fetched = await fetchSpans(args)
      const grades = gradeSessions(fetched.spans)
      const validation = validateGrade({ args, fetched, grades })
      last = {
        endpoint: args.endpoint,
        project: args.project,
        runId: args.runId,
        commit: args.commit,
        session: args.session,
        fetched,
        grades,
        validation,
        attempts: attempt,
      }
      if (validation.valid) break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      last = {
        endpoint: args.endpoint,
        project: args.project,
        runId: args.runId,
        commit: args.commit,
        session: args.session,
        error: lastError,
        attempts: attempt,
      }
    }
    await Bun.sleep(1_000)
  }

  const validation = last?.validation as ReturnType<typeof validateGrade> | undefined
  const flushValid = input.flush === "completed"
  const reasons = [
    ...(validation?.reasons ?? (lastError ? [lastError] : ["Phoenix grading did not return a validation result"])),
    ...(!flushValid ? [`telemetry flush was ${input.flush}`] : []),
  ]
  const fetched = last?.fetched as Awaited<ReturnType<typeof fetchSpans>> | undefined
  const observability: HarnessObservability = {
    ...empty,
    traceIds: [...new Set((fetched?.spans ?? []).map((span) => span.trace_id).filter(Boolean))],
    spanCount: validation?.spanCount ?? 0,
    unattributedSpanCount: validation?.unattributedSpanCount ?? 0,
    paginationComplete: fetched?.paginationComplete ?? false,
    completionSpanFound: validation?.completionSpanFound ?? false,
    grade: validation?.valid && flushValid ? "valid" : "invalid",
  }
  return {
    observability,
    report: { ...(last ?? {}), flush: input.flush, combinedValidation: { valid: reasons.length === 0, reasons } },
    errors: reasons,
  }
}

async function prepareSource(input: {
  options: HeadlessHarnessOptions
  repository: string
  isolation: HarnessIsolation
  commit: string
  started: Date
}): Promise<Omit<HarnessPreflight, "pythonRuntime">> {
  if (input.options.testOnlyUseCurrentSource) {
    input.isolation.source = input.repository
    return {
      sourceAdded: false,
      failed: false,
      bunLockSha256: await sha256File(path.join(input.repository, "bun.lock")),
      errors: [],
      attempt: {
        index: 1,
        phase: "preflight",
        status: "completed",
        startedAt: input.started.toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
      },
    }
  }

  const preflightStarted = new Date()
  const add = await runCommand({
    command: "git",
    args: ["worktree", "add", "--detach", input.isolation.source, input.commit],
    cwd: input.repository,
    timeoutMs: 120_000,
  })
  if (add.exitCode !== 0) {
    return {
      sourceAdded: false,
      failed: true,
      bunLockSha256: sha256Bytes(""),
      errors: [{ kind: "worktree", message: add.stderr.trim() || add.stdout.trim() }],
      attempt: {
        index: 1,
        phase: "preflight",
        status: "failed",
        startedAt: preflightStarted.toISOString(),
        finishedAt: new Date().toISOString(),
      },
    }
  }

  const bunLockSha256 = await sha256File(path.join(input.isolation.source, "bun.lock"))
  const install = await runCommand({
    command: "bun",
    args: ["install", "--frozen-lockfile"],
    cwd: input.isolation.source,
    env: input.isolation.env,
    inheritEnv: false,
    timeoutMs: 300_000,
  })
  const installOutput = install.exitCode === 0 ? undefined : install.stderr.trim() || install.stdout.trim()
  const installError = install.exitCode === 0 ? undefined : installOutput || "frozen install failed"
  return {
    sourceAdded: true,
    failed: install.exitCode !== 0,
    bunLockSha256,
    errors: installError ? [{ kind: "dependency_preflight", message: installError }] : [],
    attempt: {
      index: 1,
      phase: "preflight",
      status: install.exitCode === 0 ? "completed" : "failed",
      startedAt: preflightStarted.toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: install.exitCode,
      ...(installOutput ? { error: installOutput } : {}),
    },
  }
}

async function requiredDependencyError(input: { source: string; required?: string[] }): Promise<string | undefined> {
  if (!input.required?.length) return
  const missing = await missingDependencies(input.source, input.required)
  return missing.length > 0 ? `missing required dependencies: ${missing.join(", ")}` : undefined
}

async function prepareHarnessRuntime(input: {
  options: HeadlessHarnessOptions
  repository: string
  isolation: HarnessIsolation
  commit: string
  started: Date
}): Promise<HarnessPreflight> {
  const prepared = await prepareSource(input)
  if (prepared.failed) return prepared

  const dependencyError = await requiredDependencyError({
    source: input.isolation.source,
    required: input.options.requiredDependencyPaths,
  })
  if (dependencyError) {
    return {
      ...prepared,
      failed: true,
      errors: [{ kind: "dependency_preflight", message: dependencyError }],
      attempt: { ...prepared.attempt, status: "failed", exitCode: 1, error: dependencyError },
    }
  }

  try {
    const pythonRuntime = await prepareLockedPythonRuntime({
      source: input.isolation.source,
      envDir: path.join(input.isolation.root, "python-runtime"),
      env: input.isolation.env,
    })
    return { ...prepared, pythonRuntime }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...prepared,
      failed: true,
      errors: [{ kind: "python_runtime_preflight", message }],
      attempt: {
        ...prepared.attempt,
        status: "failed",
        exitCode: 1,
        error: message,
        finishedAt: new Date().toISOString(),
      },
    }
  }
}

async function verifyPythonRuntime(input: {
  runtime?: LockedPythonRuntime
  isolation: HarnessIsolation
}): Promise<{ packagesSha256?: string; errors: string[] }> {
  if (!input.runtime) return { errors: [] }
  try {
    const inspected = await inspectLockedPythonRuntime({
      python: input.runtime.python,
      cwd: input.isolation.source,
      env: input.isolation.env,
    })
    const unchanged =
      inspected.pythonVersion === input.runtime.pythonVersion &&
      inspected.packagesSha256 === input.runtime.packagesSha256
    return {
      packagesSha256: inspected.packagesSha256,
      errors: unchanged ? [] : ["locked Python runtime fingerprint changed during execution"],
    }
  } catch (error) {
    return {
      errors: [
        `locked Python runtime post-run verification failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
}

async function cleanupDetachedSource(input: {
  sourceAdded: boolean
  source: string
  repository: string
}): Promise<{ sourceAdded: boolean; status: "completed" | "failed" }> {
  if (!input.sourceAdded) return { sourceAdded: false, status: "completed" }
  const remove = await runCommand({
    command: "git",
    args: ["worktree", "remove", "--force", input.source],
    cwd: input.repository,
    timeoutMs: 120_000,
  })
  return remove.exitCode === 0 ? { sourceAdded: false, status: "completed" } : { sourceAdded: true, status: "failed" }
}

export function runHeadlessHarness(options: HeadlessHarnessOptions): Effect.Effect<HeadlessHarnessResult, unknown> {
  return Effect.tryPromise({
    try: () => runHeadlessHarnessPromise(options),
    catch: (error) => error,
  })
}

/** Promise adapter for the Bun CLI and black-box tests. */
// @codescene(disable-all) The orchestrator is an explicit lifecycle boundary for isolated harness runs.
export async function runHeadlessHarnessPromise(options: HeadlessHarnessOptions): Promise<HeadlessHarnessResult> {
  const started = new Date()
  const id = runId()
  const scenario = await loadScenario(options.scenarioPath)
  const repository = path.resolve(options.repository ?? path.resolve(import.meta.dir, "../../../.."))
  const writer = await createBundleWriter(path.resolve(options.outputDir), id)
  const scenarioJson = canonicalScenarioJson(scenario)
  const scenarioSha256 = hashScenario(scenario)
  await writeBundleText(writer, "inputs/scenario.json", `${scenarioJson}\n`)
  const isolation = await createIsolation(id)
  // Scripted fixtures keep the deterministic offline catalog snapshot. Real
  // (non-fixture) runs need the live model catalog so opencode/* models such
  // as big-pickle or the deepseek-v4-flash-free default can resolve.
  if (!options.fixtureMode) {
    isolation.env.OPENCODE_DISABLE_MODELS_FETCH = "0"
  }
  const attempts: RunManifestV1["attempts"] = []
  const errors: RunManifestV1["errors"] = []
  let sourceAdded = false
  let preflightFailed = false
  let executionExit = 0
  let timedOut = false
  let stdout = ""
  let stderr = ""
  let commit = ""
  let targetTreeHash = ""
  let bunLockSha256 = sha256Bytes("")
  let evaluatorSourceSha256 = sha256Bytes("")
  let evaluatorEntrypointSha256 = sha256Bytes("")
  let evaluatorFixtureScriptSha256 = sha256Bytes("")
  let cleanupStatus: "completed" | "failed" = "completed"
  let scriptedModel: ScriptedModelServer | undefined
  let fixtureMarketData: FixtureMarketDataProvider | undefined
  let pythonRuntime: LockedPythonRuntime | undefined
  let postRunPackagesSha256: string | undefined
  const pythonRuntimeIntegrityErrors: string[] = []
  let executionStartedAt: Date | undefined
  let executionFinishedAt: Date | undefined
  const secretValues = Object.keys(process.env)
    .filter((key) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
    .map((key) => process.env[key] ?? "")
    .filter((value) => value.length >= 8)

  try {
    configureCollector(isolation.env, options.collectorEndpoint)
    const resolve = await runCommand({
      command: "git",
      args: ["rev-parse", options.ref],
      cwd: repository,
      timeoutMs: 30_000,
    })
    if (resolve.exitCode !== 0) throw new Error(`could not resolve ref ${options.ref}: ${resolve.stderr.trim()}`)
    commit = resolve.stdout.trim()
    isolation.env.FINNY_GIT_COMMIT = commit
    configureTelemetryIdentity(isolation.env)
    const targetTree = await runCommand({
      command: "git",
      args: ["rev-parse", `${commit}^{tree}`],
      cwd: repository,
      timeoutMs: 30_000,
    })
    if (targetTree.exitCode !== 0) throw new Error(`could not resolve target tree: ${targetTree.stderr.trim()}`)
    targetTreeHash = targetTree.stdout.trim()

    const evaluatorSource = path.resolve(import.meta.dir)
    evaluatorSourceSha256 = await hashTree(evaluatorSource)
    evaluatorEntrypointSha256 = await sha256File(path.join(evaluatorSource, "..", "headless-harness.ts"))
    evaluatorFixtureScriptSha256 = await sha256File(path.join(evaluatorSource, "fixture-model.ts"))

    const preflight = await prepareHarnessRuntime({ options, repository, isolation, commit, started })
    sourceAdded = preflight.sourceAdded
    preflightFailed = preflight.failed
    bunLockSha256 = preflight.bunLockSha256
    pythonRuntime = preflight.pythonRuntime
    attempts.push(preflight.attempt)
    errors.push(...preflight.errors)

    let effectiveModel = options.model
    if (!preflightFailed && options.fixtureMode) {
      for (const credential of isolation.credentialPresence) delete isolation.env[credential.name]
      isolation.credentialPresence.splice(0)
      fixtureMarketData = await startFixtureMarketDataProvider({
        port: isolation.ports.fixtureMarketData,
        allowedRoot: isolation.finnyHome,
        fixtureRoot: path.join(isolation.root, "fixture-market"),
        harnessMode: true,
        profile: options.fixtureMode === "positive_qualification" ? "positive_qualification" : "negative",
      })
      scriptedModel = await startScriptedModelServer({
        port: isolation.ports.scriptedModel,
        mode: options.fixtureMode,
        harnessMode: true,
      })
      isolation.env.OPENCODE_CONFIG_CONTENT = scriptedModel.configContent
      isolation.env.FINNY_HARNESS_MARKET_DATA_URL = fixtureMarketData.url
      isolation.env.FINNY_HARNESS_MARKET_DATA_CSV = fixtureMarketData.csvPath
      isolation.env.FINNY_HARNESS_MARKET_DATA_SHA256 = fixtureMarketData.csvSha256
      isolation.env.FINNY_HARNESS_FIXTURE_MARKET_DATA = "1"
      isolation.env.FINNY_HARNESS_SCRIPTED_MODEL = "1"
      if (options.fixtureMode === "positive_qualification" && scenario.approvals?.sealedHoldout === true) {
        isolation.env.FINNY_HARNESS_APPROVE_SEALED_HOLDOUT = "1"
      }
      effectiveModel = scriptedModel.model
    }

    if (!preflightFailed) {
      const executionStarted = new Date()
      executionStartedAt = executionStarted
      const opencode = path.join(isolation.source, "packages", "opencode")
      const execution = await runCommand({
        command: "bun",
        args: [
          "run",
          "--conditions=browser",
          "src/index.ts",
          "run",
          "--format",
          "json",
          // Headless fixtures have no human to click Allow; without this flag
          // run.ts auto-rejects permission prompts and tools that still ask
          // (or re-ask) can stall the scripted session until wall-clock timeout.
          "--dangerously-skip-permissions",
          "--agent",
          options.agent,
          "--model",
          effectiveModel,
          "--dir",
          isolation.source,
          "--port",
          String(isolation.ports.http),
          scenario.prompt,
        ],
        cwd: opencode,
        env: isolation.env,
        inheritEnv: false,
        timeoutMs: options.timeoutMs ?? scenario.limits.wallTimeMs,
      })
      executionExit = execution.exitCode
      timedOut = execution.timedOut
      executionFinishedAt = new Date()
      stdout = execution.stdout
      stderr = execution.stderr
      attempts.push({
        index: attempts.length + 1,
        phase: "execution",
        status: timedOut ? "timed_out" : execution.exitCode === 0 ? "completed" : "failed",
        startedAt: executionStarted.toISOString(),
        finishedAt: executionFinishedAt.toISOString(),
        exitCode: execution.exitCode,
        ...(execution.exitCode !== 0 ? { error: execution.stderr.trim().slice(0, 2_000) } : {}),
      })
    }

    const verifiedRuntime = await verifyPythonRuntime({ runtime: pythonRuntime, isolation })
    postRunPackagesSha256 = verifiedRuntime.packagesSha256
    pythonRuntimeIntegrityErrors.push(...verifiedRuntime.errors)

    await scriptedModel?.stop().catch(() => {})
    await fixtureMarketData?.stop().catch(() => {})

    stdout = redactSecrets(stdout, secretValues)
    stderr = redactSecrets(stderr, secretValues)
    await writeBundleText(writer, "raw/stdout.log", stdout)
    await writeBundleText(writer, "raw/stderr.log", stderr)
    await writeBundleText(writer, "raw/events.jsonl", stdout)
    if (scriptedModel) {
      await writeBundleText(
        writer,
        "raw/fixture-model-requests.json",
        `${JSON.stringify({ count: scriptedModel.requests(), paths: scriptedModel.requestBodies().map((body) => ({ model: body.model, stream: body.stream })) }, null, 2)}\n`,
      )
    }

    const collectedArtifacts = await collectFinnyArtifacts({
      writer,
      finnyHome: isolation.finnyHome,
      secretValues,
    })
    await writeBundleText(
      writer,
      "artifact-index.json",
      `${JSON.stringify({ schemaVersion: "1.0.0", ...collectedArtifacts.capture, files: collectedArtifacts.index }, null, 2)}\n`,
    )
    const inspectedRuns = await inspectStrategyResults(isolation.finnyHome)
    const integrityIssues: HarnessIntegrityIssue[] = [
      ...pythonRuntimeIntegrityErrors.map((message) => ({ kind: "artifact_integrity" as const, message })),
      ...collectedArtifacts.issues,
      ...inspectedRuns.issues,
    ]

    const events = parseJsonEvents(stdout)
    const observation = observeRun(events, scenario)
    integrityIssues.push(
      ...bindObservedStrictRuns({
        finnyHome: isolation.finnyHome,
        savedCandidates: observation.savedCandidates,
        backtests: observation.backtestRuns,
        runs: inspectedRuns.runs,
        scenario: scenario.request,
      }),
    )
    const observability = await collectObservability({
      required: scenario.observabilityRequired && !preflightFailed,
      endpoint: isolation.env.PHOENIX_COLLECTOR_ENDPOINT,
      project: isolation.phoenixProject,
      runId: id,
      commit,
      sessionId: observation.mainSession,
      since: executionStartedAt,
      until: executionFinishedAt,
      flush: telemetryFlush(events),
    })
    await writeBundleText(
      writer,
      "observability/phoenix-grade.json",
      `${redactSecrets(JSON.stringify(observability.report, null, 2), secretValues)}\n`,
    )
    const outcome = classifyOutcome({
      preflightFailed,
      timedOut,
      childExitCode: executionExit,
      observation,
      observabilityRequired: scenario.observabilityRequired,
      observabilityAvailable: Boolean(isolation.env.PHOENIX_COLLECTOR_ENDPOINT),
      integrityErrors: integrityIssues.map((issue) => issue.message),
      observabilityErrors: observability.errors,
    })
    const strategyResults = inspectedRuns.results
    const finished = new Date()

    const cleanup = await cleanupDetachedSource({ sourceAdded, source: isolation.source, repository })
    sourceAdded = cleanup.sourceAdded
    cleanupStatus = cleanup.status

    const base: Omit<RunManifestV1, "artifacts" | "integrity"> = {
      schemaVersion: "1.0.0",
      runId: id,
      scenarioId: scenario.id,
      status: outcome.status,
      exitCode: outcome.exitCode,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      source: {
        ref: options.ref,
        commit,
        targetTreeHash,
        treeState: "clean",
        preparation: options.testOnlyUseCurrentSource ? "test_current_checkout" : "detached_worktree_frozen_install",
        bunLockSha256,
        evaluatorSourceSha256,
        evaluatorEntrypointSha256,
        scenarioSha256,
      },
      runtime: {
        os: os.platform(),
        arch: os.arch(),
        bunVersion: Bun.version,
        pythonVersion: pythonRuntime?.pythonVersion,
        uvVersion: pythonRuntime?.uvVersion,
        pythonPackagesSha256: postRunPackagesSha256 ?? pythonRuntime?.packagesSha256,
        pythonPackagesPreflightSha256: pythonRuntime?.packagesSha256,
        pythonLockSha256: pythonRuntime?.lockSha256,
        pythonRuntimeManifestSha256: pythonRuntime?.manifestSha256,
      },
      model: {
        id: effectiveModel,
        agent: options.agent,
        ...(options.fixtureMode
          ? {
              fixtureMode: options.fixtureMode,
              requestCount: scriptedModel?.requests() ?? 0,
              configSha256: sha256Bytes(scriptedModel?.configContent ?? ""),
              scriptSha256: evaluatorFixtureScriptSha256,
            }
          : {}),
      },
      isolation: {
        namespace: id,
        reusedState: false,
        finnyHome: "isolated/finny-home",
        database: "isolated/db/opencode.db",
        xdgData: "isolated/xdg/data",
        xdgState: "isolated/xdg/state",
        xdgCache: "isolated/xdg/cache",
        xdgConfig: "isolated/xdg/config",
        phoenixProject: isolation.phoenixProject,
        ports: isolation.ports,
        cleanupStatus,
      },
      attempts,
      sessions: { main: observation.mainSession, subagents: observation.subagents },
      stages: observation.stages,
      requestAdherence: {
        expected: scenario.request,
        observed: {
          algorithms: observation.algorithms,
          versionsByAlgorithm: observation.versionsByAlgorithm,
          backtests: observation.backtests,
          completedBacktests: observation.completedBacktests,
          savedCandidates: observation.savedCandidates,
          backtestRuns: observation.backtestRuns.map((run) => ({
            ...run,
            ...(run.artifactDir ? { artifactDir: path.relative(isolation.finnyHome, run.artifactDir) } : {}),
          })),
          toolCalls: observation.toolCalls,
          modelTurns: observation.modelTurns,
          requestIdentity: observation.requestIdentity,
          credentialPresence: isolation.credentialPresence,
        },
        violations: observation.violations,
      },
      strategyResults,
      recoveries: observation.recoveries,
      errors: [
        ...errors,
        ...observation.errors,
        ...integrityIssues,
        ...observability.errors.map((message) => ({ kind: "observability", message })),
      ],
      observability: { ...observability.observability, required: scenario.observabilityRequired },
      semanticHashes: {
        source: semanticHash({
          commit,
          targetTreeHash,
          bunLockSha256,
          evaluatorSourceSha256,
          evaluatorEntrypointSha256,
          scenarioSha256,
        }),
        ...(fixtureMarketData ? { fixtureData: fixtureMarketData.csvSha256 } : {}),
        normalizedEvents: semanticEventHash(observation),
        contract: semanticHash({
          scenarioSha256,
          stages: observation.stages,
          violations: observation.violations,
          recoveries: observation.recoveries,
        }),
        strategyResults: semanticHash(strategyResults, [id, isolation.root]),
      },
    }
    const published = await publishBundle(writer, base)
    await fs.rm(isolation.root, { recursive: true, force: true }).catch(() => {})
    return { manifest: published.manifest, bundlePath: published.bundlePath, exitCode: outcome.exitCode }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await scriptedModel?.stop().catch(() => {})
    await fixtureMarketData?.stop().catch(() => {})
    stdout = redactSecrets(stdout, secretValues)
    stderr = redactSecrets(`${stderr}\n${message}\n`, secretValues)
    await writeBundleText(writer, "raw/stdout.log", stdout)
    await writeBundleText(writer, "raw/stderr.log", stderr)
    const cleanup = await cleanupDetachedSource({ sourceAdded, source: isolation.source, repository })
    cleanupStatus = cleanup.status
    const finished = new Date()
    const emptyObservation = observeRun([], scenario)
    const outcome = classifyOutcome({ internalError: true, observation: emptyObservation })
    const published = await publishBundle(writer, {
      schemaVersion: "1.0.0",
      runId: id,
      scenarioId: scenario.id,
      status: outcome.status,
      exitCode: outcome.exitCode,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      source: {
        ref: options.ref,
        commit,
        targetTreeHash,
        treeState: "clean",
        preparation: options.testOnlyUseCurrentSource ? "test_current_checkout" : "detached_worktree_frozen_install",
        bunLockSha256,
        evaluatorSourceSha256,
        evaluatorEntrypointSha256,
        scenarioSha256,
      },
      runtime: { os: os.platform(), arch: os.arch(), bunVersion: Bun.version },
      model: {
        id: options.fixtureMode ? "harness/scripted" : options.model,
        agent: options.agent,
        ...(options.fixtureMode
          ? {
              fixtureMode: options.fixtureMode,
              requestCount: scriptedModel?.requests() ?? 0,
              configSha256: sha256Bytes(scriptedModel?.configContent ?? ""),
              scriptSha256: evaluatorFixtureScriptSha256,
            }
          : {}),
      },
      isolation: {
        namespace: id,
        reusedState: false,
        finnyHome: "isolated/finny-home",
        database: "isolated/db/opencode.db",
        xdgData: "isolated/xdg/data",
        xdgState: "isolated/xdg/state",
        xdgCache: "isolated/xdg/cache",
        xdgConfig: "isolated/xdg/config",
        phoenixProject: isolation.phoenixProject,
        ports: isolation.ports,
        cleanupStatus,
      },
      attempts,
      sessions: { subagents: [] },
      stages: emptyObservation.stages,
      requestAdherence: { expected: scenario.request, observed: {}, violations: emptyObservation.violations },
      strategyResults: [],
      recoveries: [],
      errors: [...errors, { kind: "internal_error", message }],
      observability: {
        required: scenario.observabilityRequired,
        project: isolation.phoenixProject,
        traceIds: [],
        spanCount: 0,
        unattributedSpanCount: 0,
        paginationComplete: false,
        completionSpanFound: false,
        flush: "not_run",
        grade: "not_run",
      },
      semanticHashes: {
        source: semanticHash({
          commit,
          targetTreeHash,
          bunLockSha256,
          evaluatorSourceSha256,
          evaluatorEntrypointSha256,
          scenarioSha256,
        }),
        ...(fixtureMarketData ? { fixtureData: fixtureMarketData.csvSha256 } : {}),
        normalizedEvents: semanticHash([], [id, isolation.root, isolation.source]),
        contract: semanticHash({
          scenarioSha256,
          stages: emptyObservation.stages,
          violations: emptyObservation.violations,
        }),
        strategyResults: semanticHash([]),
      },
    })
    await fs.rm(isolation.root, { recursive: true, force: true }).catch(() => {})
    return { manifest: published.manifest, bundlePath: published.bundlePath, exitCode: outcome.exitCode }
  }
}
