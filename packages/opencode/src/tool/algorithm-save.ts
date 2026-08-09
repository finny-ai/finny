import { createHash } from "node:crypto"
import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-save.txt"
import { Algorithm } from "../algorithm"
import { Mission } from "../algorithm/mission"
import { Validate } from "../algorithm/validate"
import { RetryOrchestrator } from "../algorithm/retry-orchestrator"
import { Bus } from "../bus"
import { Process } from "../util/process"
import { readActiveBrokerKind } from "../live/brokers/active"
import { BROKER_KINDS } from "../live/brokers/types"
import { linkAlgorithmToWorkspace } from "../plugin/finny-workspace"
import {
  missingRequiredNewSaveConfigFields,
  normalizeConfigForSave,
  unsupportedNewSaveConfigReasons,
} from "../algorithm/strategy-params"
import { requireVerifiedDataExtractorEvidenceForSession } from "../data/data-extractor-evidence"
import { strategySourceV1 } from "../backtest/lean/contracts"
import { embedRuntimeConfig, runtimeForCandidate, validateLeanSourceManifest } from "../backtest/lean/select"
import { writeLeanSourceFile } from "../backtest/lean/source-store"
import { Database } from "@opencode-ai/core/database/database"
import {
  activeWorkflowForSession,
  ensureWorkflowCandidate,
  recordVerifiedMarketDataSet,
  recordWorkflowAttempt,
} from "@/algorithm/build-workflow/lifecycle"

// On Windows with no Python installed, the Microsoft Store launcher stub
// replies to `python`/`python3` with a nonzero exit and a misleading message
// that gets fed into the syntax checker as a SYNTAX_ERROR diagnostic. The
// agent then burns its full retry budget regenerating code that was never
// the problem. Detect those signatures up front and surface a clean,
// user-actionable error instead of looping.
const PYTHON_MISSING_PATTERNS: RegExp[] = [
  /Python was not found/i,
  /is not recognized as an internal or external command/i,
  /python3?: command not found/i,
  /(ENOENT.*python|python.*ENOENT)/i,
  /No such file or directory.*python/i,
]

export function looksLikePythonMissing(text: string): boolean {
  if (!text) return false
  return PYTHON_MISSING_PATTERNS.some((re) => re.test(text))
}

// Direct availability probe. `Validate.checkSyntax` swallows clean ENOENT
// (silent return null) so a user with no Python at all can pass validation
// and reach `Algorithm.save` with code that will fail at backtest time.
// Probing here closes that gap — and catches the Windows stub case before
// it ever pollutes the diagnostic stream. Result is cached for the process
// because Python availability won't change mid-session.
let pythonAvailableCache: Promise<boolean> | null = null

// Each spawn is wrapped in an AbortSignal.timeout so a hanging Windows stub
// or misbehaving wrapper script can't block the save flow. `Process.spawn`'s
// `timeout` option is just for SIGKILL escalation after SIGTERM — the abort
// signal is what enforces the actual wall-clock cap.
const PROBE_TIMEOUT_MS = 5000

// Try a single interpreter name. Returns true if it exits cleanly, false if
// it's clearly missing (Windows stub message or spawn ENOENT), and null if
// we can't tell (any other nonzero exit, weird spawn error) — null means
// "fall back to the next candidate; if all return null, treat as available
// to avoid false-positives on corrupt installs."
async function probePython(cmd: string): Promise<boolean | null> {
  try {
    const proc = Process.spawn([cmd, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      abort: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      timeout: PROBE_TIMEOUT_MS,
    })
    const stderrChunks: Buffer[] = []
    proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c))
    const exitCode = await proc.exited
    if (exitCode === 0) return true
    const stderr = Buffer.concat(stderrChunks).toString()
    if (looksLikePythonMissing(stderr)) return false
    return null
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (looksLikePythonMissing(msg)) return false
    return null
  }
}

export async function isPythonAvailable(): Promise<boolean> {
  if (pythonAvailableCache !== null) return pythonAvailableCache
  pythonAvailableCache = (async () => {
    // Try python3, then python. Both have to fail with a clear "missing"
    // signal before we hard-block — matches the fallback logic in
    // src/python/env.ts:systemPython() so this probe stays consistent with
    // how the runtime picks its interpreter.
    let unknownSeen = false
    for (const cmd of ["python3", "python"]) {
      const result = await probePython(cmd)
      if (result === true) return true
      if (result === null) unknownSeen = true
    }
    return unknownSeen
  })()
  return pythonAvailableCache
}

// Exposed so tests can reset the per-process cache between cases.
export function _resetPythonAvailableCache(): void {
  pythonAvailableCache = null
}

const PYTHON_MISSING_OUTPUT = [
  "Python isn't installed on this machine. Finny needs Python to validate",
  "and run strategies before saving them.",
  "",
  "To fix:",
  "  • macOS:   brew install python3",
  "  • Windows: install from https://www.python.org/downloads/",
  "             (do NOT use the Microsoft Store stub launcher)",
  "  • Linux:   apt install python3   (or your distro's equivalent)",
  "",
  "Once Python is on your PATH, run the save again and it'll go through.",
].join("\n")

/**
 * Count unique algorithm names against the user's saved set. Historical /
 * orphaned rows that share a name collapse to one visible algorithm, matching
 * what `algorithm-list` shows.
 *
 * Pure helper, exposed for testing.
 */
export function countUniqueAlgorithms(algos: ReadonlyArray<{ name: string }>): number {
  return new Set(algos.map((a) => a.name)).size
}

/**
 * Corrective message for an invalid/missing mission.md on save. Leads with the
 * concrete issues, then routes the agent to structured input so a retry does
 * not depend on hand-authored YAML.
 */
export function missionRejectionMessage(issues: string[]): string {
  return [
    "Invalid mission.md for this save:",
    ...issues.map((i) => `  - ${i}`),
    "",
    "Retry with the structured `docsInput` parameter and omit raw `mission` and `riskContract`. Finny will render valid schema-v4 YAML, canonical Core 8 records, frontmatter delimiters, safe quoting, and matching risk JSON.",
    "",
    "Under `docsInput.mission.questionnaire`, provide exactly these answer keys (string values; empty means explicitly skipped):",
    ...Mission.CORE8_IDS.map((id) => `  - ${id}`),
    "",
    "Raw YAML remains available only for legacy callers. If you must use it, it must be a complete schema_version: 4 mission document.",
  ].join("\n")
}

/** Bind a validated mission risk contract into the executable config. */
export function bindMissionRiskContract(config: string | undefined, mission: string | undefined): string | undefined {
  const riskContract = Mission.riskContract(mission)
  if (!riskContract) return config
  let parsed: Record<string, unknown> = {}
  if (config) {
    try {
      const value = JSON.parse(config)
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value
    } catch {}
  }
  return JSON.stringify({ ...parsed, risk_contract: riskContract })
}

export function effectiveSaveConfig(input: {
  incoming?: string
  previous?: string
  mission?: string
}): string | undefined {
  return bindMissionRiskContract(
    normalizeConfigForSave({
      incoming: input.incoming,
      previous: input.previous,
      preserveExecution: input.previous !== undefined,
    }),
    input.mission,
  )
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

/**
 * Combined mission + execution-config rejection: every structural blocker in
 * one response, so the agent fixes them in a single save round-trip instead of
 * peeling one gate per attempt. Returns undefined when both lists are empty.
 */
export function contractRejectionBlock(missionIssues: string[], configIssues: string[]) {
  if (missionIssues.length === 0 && configIssues.length === 0) return undefined
  const sections: string[] = []
  if (configIssues.length > 0) {
    sections.push(["Config issues:", ...configIssues.map((i) => `  - ${i}`)].join("\n"))
  }
  if (missionIssues.length > 0) {
    sections.push(missionRejectionMessage(missionIssues))
  }
  return {
    title: "Save blocked — mission/config contract",
    output: sections.join("\n\n"),
    metadata: {
      blocked: true,
      retry: false,
      missionInvalid: missionIssues.length > 0,
      missionIssues,
      configIssues,
      configRequired: configIssues.length > 0,
    },
  }
}

const SAVE_PREFLIGHT_RETRY_LIMIT = 2
const savePreflightFailures = new Map<string, number>()

export function recordSavePreflightFailure(sessionID: string, fingerprint: string): number {
  const key = `${sessionID}:${fingerprint}`
  const failures = (savePreflightFailures.get(key) ?? 0) + 1
  savePreflightFailures.set(key, failures)
  return failures
}

export function savePreflightRetryMessage(failures: number, configIssues: string[]): string {
  const docsModeConflict = configIssues.some((issue) =>
    issue.includes('docsMode "inherit" cannot replace mission, preferences, or riskContract'),
  )
  if (failures >= SAVE_PREFLIGHT_RETRY_LIMIT) {
    return [
      `BLOCKED: save preflight retry limit reached (${failures}/${SAVE_PREFLIGHT_RETRY_LIMIT}) for unchanged inputs.`,
      "",
      docsModeConflict
        ? 'Stop this build attempt now. The only valid next call changes docsMode to "replace" while preserving saveMode "version" and the replacement docsInput. Do not call finny_algorithm_save again with docsMode "inherit".'
        : "Stop this build attempt now. Correct the listed mission/config inputs before calling finny_algorithm_save again; do not repeat the unchanged call.",
    ].join("\n")
  }
  return docsModeConflict
    ? 'NEXT ACTION (one retry maximum): preserve saveMode "version" and the replacement docsInput, but change docsMode from "inherit" to "replace". Do not retry with docsMode "inherit".'
    : "NEXT ACTION (one retry maximum): correct every listed mission/config issue before calling finny_algorithm_save again. Do not repeat the unchanged call."
}

export function _resetSavePreflightGuardForTests(): void {
  savePreflightFailures.clear()
}

export function validationWarningsBlock(warnings: Validate.Diagnostic[]) {
  if (warnings.length === 0) return undefined
  return {
    title: "Failed to save strategy",
    output: [
      "Failed to save strategy: validator warnings must be cleared before save/backtest.",
      RetryOrchestrator.formatWarningRejection(warnings),
      "Fix: correct every warning, then call finny_algorithm_save again with the corrected strategy.",
    ].join("\n\n"),
    metadata: {
      blocked: true,
      retry: true,
      diagnosticCount: warnings.length,
      diagnosticCodes: warnings.map((warning) => warning.code),
    },
  }
}

const questionnaireInput = z
  .object({
    market_universe: z.string(),
    timeframe_bar_interval: z.string(),
    strategy_family: z.string(),
    directional_thesis_regime: z.string(),
    entry_signal_idea: z.string(),
    exit_invalidation_rules: z.string(),
    risk_tolerance_max_drawdown: z.string(),
    backtest_window_success_metric: z.string(),
  })
  .describe("Answers to the Core 8. Use an empty string for an explicitly skipped answer.")

const missionInput = z.object({
  status: z.enum(["research", "backtested", "paper", "live", "retired"]).optional(),
  created: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  hypothesis: z.string().min(1),
  scope: z.object({
    asset_class: z.enum(["equities", "crypto", "futures", "fx", "options", "mixed"]),
    universe: z.array(z.string().min(1)).min(1),
    horizon: z.enum(["intraday", "days", "weeks", "months"]),
  }),
  strategy: z.object({
    bar_interval: z.union([z.string().min(1), z.number()]),
    type: z.string().min(1),
    direction: z.enum(["long", "short", "both"]),
    entry_signal: z.string().min(1),
    risk_profile: z.string().min(1),
    max_drawdown_pct: z.union([z.string().min(1), z.number()]),
    backtest_window: z.union([z.string().min(1), z.number()]),
    success_metric: z.string().min(1),
  }),
  risk_contract: Mission.RiskContractSchema,
  exit_conditions: z.string().min(1),
  questionnaire: questionnaireInput,
  user_preferences: z.string().optional(),
  body: z.string().optional(),
})

const docsInput = z
  .object({
    mission: missionInput,
    prefs: z.string().optional(),
    decisions: z.string().optional(),
  })
  .describe(
    "Preferred structured document input. Finny renders valid schema-v4 mission YAML and matching risk JSON; do not hand-author YAML when using this.",
  )

const CORE8_QUESTIONS: Record<(typeof Mission.CORE8_IDS)[number], string> = {
  market_universe: "What market and universe should the strategy trade?",
  timeframe_bar_interval: "What timeframe and bar interval should the strategy use?",
  strategy_family: "What strategy family should it use?",
  directional_thesis_regime: "What is the directional thesis and target regime?",
  entry_signal_idea: "What should trigger an entry?",
  exit_invalidation_rules: "What should trigger an exit or invalidate the thesis?",
  risk_tolerance_max_drawdown: "What is the risk tolerance and maximum drawdown?",
  backtest_window_success_metric: "What backtest window and success metric should be used?",
}

type DocumentParams = {
  name: string
  docsInput?: z.infer<typeof docsInput>
  mission?: string
  prefs?: string
  decisions?: string
  riskContract?: string
}

/** Resolve documents once so structured input cannot be overridden by stale/raw YAML. */
export function resolveSaveDocuments(params: DocumentParams) {
  if (!params.docsInput)
    return {
      mission: params.mission,
      prefs: params.prefs,
      decisions: params.decisions,
      riskContract: params.riskContract,
    }
  const input = params.docsInput.mission
  const questionnaire = Mission.CORE8_IDS.map((id) => {
    const answer = input.questionnaire[id]
    return {
      id,
      question: CORE8_QUESTIONS[id],
      answer,
      status: answer.trim().length > 0 ? ("answered" as const) : ("skipped" as const),
    }
  })
  const mission = Mission.renderV4({
    name: params.name,
    status: input.status,
    created: input.created,
    hypothesis: input.hypothesis,
    scope: input.scope,
    strategy: input.strategy,
    risk_contract: input.risk_contract,
    exit_conditions: input.exit_conditions,
    questionnaire,
    userPreferences: input.user_preferences,
    body: input.body,
  })
  return {
    mission,
    prefs: params.docsInput.prefs,
    decisions: params.docsInput.decisions,
    riskContract: `${JSON.stringify(input.risk_contract, null, 2)}\n`,
  }
}

const parameters = z.object({
  name: z.string().describe("Short descriptive name for the algorithm (kebab-case)"),
  code: z.string().describe("The full strategy.py source code"),
  saveMode: z
    .enum(["new", "version"])
    .describe(
      'REQUIRED. Pick "new" to create a sibling algorithm (fresh lineage, version=1) or "version" to bump the existing algorithm with this name (version+1, history preserved). No default. See the tool description for the heuristic.',
    ),
  docsMode: z
    .enum(["inherit", "replace"])
    .optional()
    .describe(
      'REQUIRED when saveMode is "version". "inherit" snapshots the prior mission/preferences/risk unchanged; "replace" uses the supplied documents. decisions is always append-only.',
    ),
  language: z.string().optional().describe("Programming language, defaults to python"),
  runtimeProfile: z
    .enum(["finny_python", "lean_python", "lean_csharp", "qc_cloud"])
    .optional()
    .describe(
      "Execution runtime for this version. Defaults to finny_python (existing engine_v2 path). " +
        "lean_python/lean_csharp are opt-in LEAN runtimes that additionally require strategySource and stay " +
        "non-promotable until the LEAN adapter certificate is active.",
    ),
  strategySource: z
    .object({
      files: z
        .array(
          z.object({
            path: z.string().describe("Relative project path, e.g. main.py or Algorithm/Main.cs"),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            bytes: z.number().int().nonnegative(),
          }),
        )
        .min(1)
        .max(64),
    })
    .optional()
    .describe("Exact LEAN project file manifest (path + sha256 + bytes). Required for lean_python/lean_csharp."),
  description: z.string().optional().describe("Brief human-readable summary of the strategy"),
  config: z.string().optional().describe("The config.json content as a string"),
  reasoning: z
    .string()
    .optional()
    .describe(
      "Markdown explaining why this version exists — what changed and why. Written to reasoning.md inside the version directory.",
    ),
  docsInput: docsInput.optional(),
  mission: z
    .string()
    .optional()
    .describe(
      "WHO: the hypothesis, scope, and exit conditions. Version replacements write mission.md in the new version.",
    ),
  prefs: z
    .string()
    .optional()
    .describe(
      "HOW: sizing, risk constraints, interval, target asset. Version replacements write prefs.md in the new version.",
    ),
  decisions: z
    .string()
    .optional()
    .describe("Design decisions to append to the immutable decisions.md history for the new version."),
  riskContract: z.string().optional().describe("JSON risk contract saved as risk.json with the version."),
  targetBrokerage: z
    .enum(BROKER_KINDS)
    .optional()
    .describe(
      "Target brokerage for live deployment. Use when building a strategy for a brokerage the user hasn't connected yet (e.g. futures on Alpaca → target ibkr). Backtest runs immediately; live deploy requires the target brokerage to be connected later.",
    ),
})

// Payload the async body returns: the tool's ExecuteResult-shaped value, plus (optionally)
// a regenerating event to publish once we're back in an Effect context.
type SaveOutcome = {
  result: {
    title: string
    output: string
    metadata: Record<string, unknown>
  }
  regenEvent?: {
    sessionID: string
    algorithmName: string
    attempt: number
    maxAttempts: number
    errorCodes: string[]
  }
}

export const AlgorithmSaveTool = Tool.define(
  "finny_algorithm_save",
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const database = yield* Database.Service
    const runWorkflow = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      Effect.runPromise(Effect.provideService(effect, Database.Service, database))

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Resolve and validate all document/config-only save inputs before
          // registering a durable candidate fingerprint. These checks do not
          // inspect strategy code and a caller must be able to correct only
          // docsMode/docsInput and retry the identical code/config. Recording
          // the attempt first poisoned that unsaved fingerprint as terminal.
          const documents = resolveSaveDocuments(params)
          const previousAlgorithm =
            params.saveMode === "version" ? yield* Effect.promise(() => Algorithm.get(params.name)) : undefined
          // Validate the exact merged config Algorithm.save will persist. A
          // version patch can omit inherited risk_contract fields; validating
          // only the incoming patch let save pass and backtest reject the same
          // version moments later.
          const normalizedConfig = effectiveSaveConfig({
            incoming: params.config,
            previous: previousAlgorithm?.config,
            mission: documents.mission,
          })
          const missionRiskContract = Mission.riskContract(documents.mission)
          const normalizedRiskContract = missionRiskContract
            ? `${JSON.stringify(missionRiskContract, null, 2)}\n`
            : documents.riskContract
          const missionIssues =
            params.saveMode === "new" || params.docsMode === "replace" || documents.mission !== undefined
              ? Mission.validateForNewSave(documents.mission)
              : []
          const configIssues: string[] = []
          if (params.runtimeProfile === "lean_python" || params.runtimeProfile === "lean_csharp") {
            const previousRuntime = previousAlgorithm ? runtimeForCandidate(previousAlgorithm).profile.profileId : undefined
            if (params.saveMode === "version" && previousRuntime && previousRuntime !== params.runtimeProfile) {
              configIssues.push(
                `runtime change ${previousRuntime} -> ${params.runtimeProfile} requires a new algorithm (saveMode "new"); ` +
                  `changing runtimes must create a new candidate version and plan`,
              )
            }
            const derivedFiles =
              params.runtimeProfile === "lean_python" && !params.strategySource
                ? [
                    {
                      path: "main.py",
                      sha256: createHash("sha256").update(params.code).digest("hex"),
                      bytes: Buffer.byteLength(params.code, "utf8"),
                    },
                  ]
                : params.strategySource?.files
            let source: ReturnType<typeof strategySourceV1> | undefined
            try {
              source = derivedFiles
                ? strategySourceV1({
                    profileId: params.runtimeProfile,
                    files: derivedFiles,
                  })
                : undefined
            } catch (error) {
              configIssues.push(`strategy source manifest is invalid: ${error instanceof Error ? error.message : String(error)}`)
            }
            const sourceIssues = validateLeanSourceManifest(source, params.runtimeProfile)
            if (sourceIssues.length > 0) {
              configIssues.push(...sourceIssues)
            }
          }
          if (missionRiskContract && documents.riskContract) {
            try {
              if (canonicalJson(JSON.parse(documents.riskContract)) !== canonicalJson(missionRiskContract)) {
                configIssues.push("riskContract must exactly match mission.risk_contract")
              }
            } catch {
              configIssues.push("riskContract must be valid JSON matching mission.risk_contract")
            }
          }
          if (params.saveMode === "version" && !params.docsMode) {
            configIssues.push('version saves require docsMode: "inherit" or "replace"')
          }
          if (
            params.saveMode === "version" &&
            params.docsMode === "inherit" &&
            (documents.mission !== undefined || documents.prefs !== undefined || documents.riskContract !== undefined)
          ) {
            configIssues.push(
              'docsMode "inherit" cannot replace mission, preferences, or riskContract; use docsMode: "replace"',
            )
          }
          if (params.saveMode === "new") {
            const missingConfig = missingRequiredNewSaveConfigFields(normalizedConfig)
            if (missingConfig.length > 0) {
              configIssues.push(
                `missing required config field(s): ${missingConfig.join(", ")} — include symbol, asset_class, ` +
                  `interval, required_history_bars, and non-empty strategy params under params in the save config; do not save first ` +
                  `and patch with finny_algorithm_set_params`,
              )
            }
            const unsupported = unsupportedNewSaveConfigReasons(normalizedConfig)
            configIssues.push(...unsupported)
            if (unsupported.length > 0) {
              configIssues.push(
                "for multi-portfolio requests, run a portfolio backtest or save one complete strategy per symbol — do not narrow to one ticker without user approval",
              )
            }
          }
          const contractBlock = contractRejectionBlock(missionIssues, configIssues)
          if (contractBlock) {
            const preflightFingerprint = createHash("sha256")
              .update(
                canonicalJson({
                  name: params.name,
                  saveMode: params.saveMode,
                  docsMode: params.docsMode,
                  code: params.code,
                  config: params.config,
                  mission: params.mission,
                  prefs: params.prefs,
                  decisions: params.decisions,
                  riskContract: params.riskContract,
                  docsInput: params.docsInput,
                }),
              )
              .digest("hex")
            const failures = recordSavePreflightFailure(ctx.sessionID, preflightFingerprint)
            const retryMessage = savePreflightRetryMessage(failures, configIssues)
            if (failures >= SAVE_PREFLIGHT_RETRY_LIMIT) {
              yield* Effect.promise(() =>
                runWorkflow(
                  recordWorkflowAttempt({
                    sessionId: ctx.sessionID,
                    operation: "finny_algorithm_save:contract_preflight",
                    fingerprint: preflightFingerprint,
                    idempotencyKey: `save:contract_preflight:${preflightFingerprint}`,
                    outcome: "blocked",
                    lifecycle: "terminal",
                    blockerCode: "save_contract_retry_limit",
                    requiredChanges: configIssues.some((issue) => issue.includes('docsMode "inherit"'))
                      ? ['change docsMode from "inherit" to "replace"']
                      : ["correct the rejected mission/config inputs"],
                  }),
                ),
              )
            }
            return {
              ...contractBlock,
              output: `${contractBlock.output}\n\n${retryMessage}`,
              metadata: {
                ...contractBlock.metadata,
                preflightFailures: failures,
                retryLimit: SAVE_PREFLIGHT_RETRY_LIMIT,
                retryLimitReached: failures >= SAVE_PREFLIGHT_RETRY_LIMIT,
                blockerCode: failures >= SAVE_PREFLIGHT_RETRY_LIMIT ? "save_contract_retry_limit" : undefined,
              },
            }
          }

          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify({
                name: params.name,
                saveMode: params.saveMode,
                code: params.code,
                config: params.config,
                mission: params.mission,
                riskContract: params.riskContract,
              }),
            )
            .digest("hex")
          const durableStart = yield* Effect.promise(() =>
            runWorkflow(
              recordWorkflowAttempt({
                sessionId: ctx.sessionID,
                operation: "finny_algorithm_save",
                fingerprint,
                idempotencyKey: `save:begin:${fingerprint}`,
                outcome: "accepted",
              }),
            ),
          )
          if (!durableStart.allowed) {
            return {
              title: "Save blocked by durable workflow",
              output: `BLOCKED: ${durableStart.message}`,
              metadata: { blocked: true, retry: false, blockerCode: durableStart.code },
            }
          }
          const outcomeExit = yield* Effect.exit(
            Effect.promise(async (): Promise<SaveOutcome> => {
              const _permission = await Effect.runPromise(
                ctx.ask({
                  permission: "finny_algorithm_save",
                  patterns: ["*"],
                  always: ["*"],
                  metadata: {},
                }),
              )

              const evidence = await requireVerifiedDataExtractorEvidenceForSession(ctx.sessionID)
              let workflow = evidence.ok
                ? await runWorkflow(
                    recordVerifiedMarketDataSet({ sessionId: ctx.sessionID, datasets: evidence.datasets }),
                  )
                : await runWorkflow(activeWorkflowForSession(ctx.sessionID))

              // Environment hard-stop #1: Python isn't installed at all. Probe
              // before validation so we don't let a clean ENOENT slip through
              // `Validate.checkSyntax`'s silent-skip branch and reach save.
              const isLeanSave = params.runtimeProfile === "lean_python" || params.runtimeProfile === "lean_csharp"
              if (!isLeanSave && !(await isPythonAvailable())) {
                RetryOrchestrator.reset(ctx.sessionID, params.name)
                return {
                  result: {
                    title: "Python isn't installed",
                    output: PYTHON_MISSING_OUTPUT,
                    metadata: {
                      blocked: true,
                      retry: false,
                      transient: false,
                      environmentBlock: "python_not_installed",
                    },
                  },
                }
              }

              // Run validation through the retry orchestrator so the attempt counter,
              // transient flagging, and max-retry handling all live in one place.
              const validation = isLeanSave
                ? ({ kind: "passed", attempts: 1, warnings: [] } satisfies RetryOrchestrator.PassedSignal)
                : await RetryOrchestrator.attempt({
                    sessionID: ctx.sessionID,
                    algorithmName: params.name,
                    code: params.code,
                    // Validate the same mission-bound risk contract that will be
                    // persisted. Using the raw incoming config let a save pass
                    // without protective-stop checks, only for finny_backtest to
                    // reject the identical saved version moments later.
                    config: normalizedConfig,
                  })

              // Environment hard-stop: if the validator failed because Python
              // isn't on PATH, no amount of retrying will help — the code was
              // never the problem. Surface a single user-visible error and clear
              // the retry counter so the next save (after the user installs
              // Python) starts fresh.
              if (validation.kind !== "passed") {
                const probe =
                  validation.kind === "retry"
                    ? validation.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n")
                    : validation.report
                if (looksLikePythonMissing(probe)) {
                  RetryOrchestrator.reset(ctx.sessionID, params.name)
                  return {
                    result: {
                      title: "Python isn't installed",
                      output: PYTHON_MISSING_OUTPUT,
                      metadata: {
                        blocked: true,
                        retry: false,
                        transient: false,
                        environmentBlock: "python_not_installed",
                      },
                    },
                  }
                }
              }

              // Validation failed, but we still have budget — tell the agent to rewrite.
              // Marked `transient: true` so the TUI suppresses this from the user.
              if (validation.kind === "retry") {
                const errorCodes = validation.diagnostics.map((d) => d.code)
                return {
                  result: {
                    title: "Failed to save strategy — fixing",
                    output: RetryOrchestrator.buildRetryInstruction(validation),
                    metadata: {
                      blocked: true,
                      retry: true,
                      transient: true,
                      attempt: validation.attempt,
                      maxAttempts: validation.maxAttempts,
                      errorCount: validation.diagnostics.length,
                      errorCodes,
                    },
                  },
                  regenEvent: {
                    sessionID: ctx.sessionID,
                    algorithmName: params.name,
                    attempt: validation.attempt,
                    maxAttempts: validation.maxAttempts,
                    errorCodes,
                  },
                }
              }

              // Exhausted all retries — surface a clean, user-visible error.
              if (validation.kind === "exhausted") {
                return {
                  result: {
                    title: "Failed to save strategy",
                    output: RetryOrchestrator.buildExhaustedMessage(validation),
                    metadata: {
                      blocked: true,
                      retry: false,
                      transient: false,
                      exhausted: true,
                      attempts: validation.attempts,
                    },
                  },
                }
              }

              // Validation passed — proceed with save.
              const warningBlock = validationWarningsBlock(validation.warnings)
              if (warningBlock) {
                return { result: warningBlock }
              }

              // (Mission + config contract checked before code validation above.)

              // The agent never sees brokerKind — the user's per-session pick
              // (set via the TUI Brokerage capsule and persisted to
              // brokerage.json) is read here so every saved algo is permanently
              // stamped with the brokerage it was generated against.
              const activeBrokerKind = await readActiveBrokerKind()

              let algo
              try {
                const leanSourceFiles =
                  params.runtimeProfile === "lean_python" && !params.strategySource
                    ? [
                        {
                          path: "main.py",
                          sha256: createHash("sha256").update(params.code).digest("hex"),
                          bytes: Buffer.byteLength(params.code, "utf8"),
                        },
                      ]
                    : params.strategySource?.files
                const saveConfig = params.runtimeProfile
                  ? embedRuntimeConfig({
                      config: normalizedConfig,
                      profileId: params.runtimeProfile,
                      sourceFiles: leanSourceFiles,
                    })
                  : normalizedConfig
                algo = await Algorithm.save({
                  name: params.name,
                  code: params.code,
                  language: params.language,
                  description: params.description,
                  config: saveConfig,
                  reasoning: params.reasoning,
                  mission: documents.mission,
                  prefs: documents.prefs,
                  decisions: documents.decisions,
                  riskContract: normalizedRiskContract,
                  docsMode: params.docsMode,
                  brokerKind: activeBrokerKind ?? undefined,
                  targetBrokerage: params.targetBrokerage,
                  saveMode: params.saveMode,
                })
                if (params.runtimeProfile === "lean_python" || params.runtimeProfile === "lean_csharp") {
                  const files = leanSourceFiles ?? []
                  if (files.length !== 1) {
                    throw new Error(
                      `${params.runtimeProfile} v1 requires exactly one source file; multi-file content delivery is not supported yet`,
                    )
                  }
                  await writeLeanSourceFile({
                    algorithm: { algorithmId: algo.algorithmId, version: algo.version },
                    relativePath: files[0]!.path,
                    content: params.code,
                  })
                }
              } catch (err) {
                if (err instanceof Algorithm.SaveModeConflictError) {
                  const lines = [err.message]
                  if (err.suggested) lines.push(`Suggested name: "${err.suggested}".`)
                  return {
                    result: {
                      title: err.kind === "name_taken" ? "Name already in use" : "No existing algorithm to version",
                      output: lines.join(" "),
                      metadata: { blocked: true, saveModeConflict: err.kind, suggestedName: err.suggested },
                    },
                  }
                }
                if (err instanceof Algorithm.DocsModeRequiredError) {
                  return {
                    result: {
                      title: "Version save blocked — docsMode required",
                      output: err.message,
                      metadata: { blocked: true, docsModeRequired: true },
                    },
                  }
                }
                throw err
              }

              const parts: string[] = [
                JSON.stringify(
                  {
                    algorithmId: algo.algorithmId,
                    name: algo.name,
                    version: algo.version,
                    status: algo.status,
                    language: algo.language,
                    validationAttempts: validation.attempts,
                  },
                  null,
                  2,
                ),
              ]

              await linkAlgorithmToWorkspace(ctx.sessionID, {
                algorithmId: algo.algorithmId,
                name: algo.name,
                version: algo.version,
              }).catch(() => undefined)

              if (workflow && evidence.ok) {
                const config = (() => {
                  try {
                    return normalizedConfig ? JSON.parse(normalizedConfig) : {}
                  } catch {
                    return {}
                  }
                })()
                const candidate = await runWorkflow(
                  ensureWorkflowCandidate({
                    workflow,
                    algorithm: algo,
                    dataset: evidence.dataset,
                    interval: String(config.interval ?? workflow.identity.interval?.value ?? "1d"),
                    start: workflow.identity.window?.value.start,
                    end: workflow.identity.window?.value.end,
                  }),
                )
                workflow = candidate.workflow
              }

              if (!evidence.ok) {
                parts.push(
                  "",
                  "Saved for exploratory research. Verified market-data evidence is still required for strict candidate qualification and promotion.",
                )
              }

              if (validation.warnings.length > 0) {
                parts.push(
                  "",
                  "These warnings are advisory: this saved version is valid and ready for backtesting. Do not create another version solely to clear them; continue with the requested backtest workflow.",
                  "",
                  Validate.format({ valid: true, errors: [], warnings: validation.warnings }),
                )
              }

              // Soft-warn when the strategy targets a different brokerage than the active one
              const target = params.targetBrokerage
              const brokerageMismatch = target && activeBrokerKind && target !== activeBrokerKind
              if (brokerageMismatch) {
                parts.push(
                  "",
                  `⚠️ Saved for ${target.toUpperCase()}; cannot run live on ${activeBrokerKind}. Connect ${target.toUpperCase()} via Settings → Brokerages before deploying live. Backtesting works immediately.`,
                )
              }

              return {
                result: {
                  title: `Saved "${algo.name}" v${algo.version}`,
                  output: parts.join("\n"),
                  metadata: {
                    algorithmId: algo.algorithmId,
                    name: algo.name,
                    version: algo.version,
                    warningCount: validation.warnings.length + (brokerageMismatch ? 1 : 0),
                    validationAttempts: validation.attempts,
                    qualificationEligible: evidence.ok,
                    evidenceRequiredForQualification: !evidence.ok,
                    evidenceIssues: evidence.ok ? [] : evidence.issues,
                    ...(workflow
                      ? {
                          workflowId: workflow.workflowId,
                          workflowStage: workflow.stage,
                          conceptId: workflow.candidate?.conceptId,
                        }
                      : {}),
                    ...(params.targetBrokerage ? { targetBrokerage: params.targetBrokerage } : {}),
                    ...(brokerageMismatch ? { brokerageMismatch: true } : {}),
                  },
                },
              }
            }),
          )
          if (outcomeExit._tag === "Failure") {
            yield* Effect.promise(() =>
              runWorkflow(
                recordWorkflowAttempt({
                  sessionId: ctx.sessionID,
                  operation: "finny_algorithm_save:finish",
                  fingerprint,
                  idempotencyKey: `save:finish:${fingerprint}:failed`,
                  outcome: "failed",
                  lifecycle: "terminal",
                  blockerCode: "save_execution_failed",
                  requiredChanges: ["resolve the thrown save or preflight error"],
                }),
              ),
            )
            return yield* Effect.failCause(outcomeExit.cause)
          }
          const outcome = outcomeExit.value

          // Publish the regenerating event, if any. Done in the outer Effect.gen so we
          // have access to Bus.Service. Failures here must not fail the tool call.
          if (outcome.regenEvent) {
            yield* bus.publish(Algorithm.Event.Regenerating, outcome.regenEvent).pipe(Effect.catch(() => Effect.void))
          }

          const blocked = Boolean((outcome.result.metadata as Record<string, unknown>).blocked)
          yield* Effect.promise(() =>
            runWorkflow(
              recordWorkflowAttempt({
                sessionId: ctx.sessionID,
                operation: "finny_algorithm_save:finish",
                fingerprint,
                idempotencyKey: `save:finish:${fingerprint}:${blocked ? "blocked" : "accepted"}`,
                outcome: blocked ? "blocked" : "accepted",
                lifecycle: "terminal",
                blockerCode: blocked ? "save_preflight_rejected" : undefined,
                requiredChanges: blocked ? ["rejected save preflight inputs"] : [],
                artifactIds:
                  typeof (outcome.result.metadata as Record<string, unknown>).algorithmId === "string"
                    ? [String((outcome.result.metadata as Record<string, unknown>).algorithmId)]
                    : [],
              }),
            ),
          )

          return outcome.result
        }),
    }
  }),
)
