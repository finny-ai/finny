import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./algorithm-save.txt"
import { Algorithm } from "../algorithm"
import { Validate } from "../algorithm/validate"
import { RetryOrchestrator } from "../algorithm/retry-orchestrator"
import { Plan } from "../plan"
import { Bus } from "../bus"
import { Process } from "../util/process"
import { readActiveBrokerKind } from "../live/brokers/active"

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
 * orphaned rows that share a name don't consume separate cap slots — this
 * keeps the cap consistent with what `algorithm-list` shows.
 *
 * Pure helper, exposed for testing.
 */
export function countUniqueAlgorithms(algos: ReadonlyArray<{ name: string }>): number {
  return new Set(algos.map((a) => a.name)).size
}

const parameters = z.object({
  name: z.string().describe("Short descriptive name for the algorithm (kebab-case)"),
  code: z.string().describe("The full strategy.py source code"),
  saveMode: z
    .enum(["new", "version"])
    .describe(
      'REQUIRED. Pick "new" to create a sibling algorithm (fresh lineage, version=1) or "version" to bump the existing algorithm with this name (version+1, history preserved). No default. See the tool description for the heuristic.',
    ),
  language: z.string().optional().describe("Programming language, defaults to python"),
  description: z.string().optional().describe("Brief human-readable summary of the strategy"),
  config: z.string().optional().describe("The config.json content as a string"),
  backtestCode: z.string().optional().describe("The backtest.py source code"),
  reasoning: z.string().optional().describe("Markdown explaining why this version exists — what changed and why. Written to reasoning.md inside the version directory."),
  mission: z.string().optional().describe("For new algorithms only. WHO: the hypothesis, scope, and exit conditions. Written to mission.md."),
  prefs: z.string().optional().describe("For new algorithms only. HOW: sizing, risk constraints, interval, target asset. Written to prefs.md."),
  decisions: z.string().optional().describe("For new algorithms only. Design decisions log: why this approach was chosen. Written to decisions.md."),
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

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.promise(async (): Promise<SaveOutcome> => {
            const _permission = await ctx.ask({
              permission: "finny_algorithm_save",
              patterns: ["*"],
              always: ["*"],
              metadata: {},
            })

            // Environment hard-stop #1: Python isn't installed at all. Probe
            // before validation so we don't let a clean ENOENT slip through
            // `Validate.checkSyntax`'s silent-skip branch and reach save.
            if (!(await isPythonAvailable())) {
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
            const validation = await RetryOrchestrator.attempt({
              sessionID: ctx.sessionID,
              algorithmName: params.name,
              code: params.code,
              config: params.config,
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
                  title: `Validation failed — regenerating (${validation.attempt}/${validation.maxAttempts})`,
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
                  title: "Generation failed after 3 attempts",
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
            // Tier cap only applies to NEW lineages. Version bumps don't add a
            // unique algorithm slot (the lineage already counts).
            if (params.saveMode === "new") {
              const tier = await Plan.getTier()
              const cap = Plan.SAVE_CAP[tier]
              if (Number.isFinite(cap)) {
                const allAlgos = await Algorithm.list()
                if (countUniqueAlgorithms(allAlgos) >= cap) {
                  const upgradeTo =
                    tier === "free" ? "Finny Lite (15) or Finny Pro (unlimited)" : "Finny Pro for unlimited algorithms"
                  return {
                    result: {
                      title: `Save blocked — ${tier} tier limit`,
                      output: `Your plan (${tier}) allows up to ${cap} saved algorithms. Delete an existing algorithm or upgrade to ${upgradeTo}.\n\nTo delete an algorithm, go to My Algos and click Delete on one you no longer need.`,
                      metadata: { blocked: true },
                    },
                  }
                }
              }
            }

            // The agent never sees brokerKind — the user's per-session pick
            // (set via the TUI Brokerage capsule and persisted to
            // brokerage.json) is read here so every saved algo is permanently
            // stamped with the brokerage it was generated against.
            const activeBrokerKind = await readActiveBrokerKind()

            let algo
            try {
              algo = await Algorithm.save({
                name: params.name,
                code: params.code,
                language: params.language,
                description: params.description,
                config: params.config,
                backtestCode: params.backtestCode,
                reasoning: params.reasoning,
                mission: params.mission,
                prefs: params.prefs,
                decisions: params.decisions,
                brokerKind: activeBrokerKind ?? undefined,
                saveMode: params.saveMode,
              })
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

            if (validation.warnings.length > 0) {
              parts.push("", Validate.format({ valid: true, errors: [], warnings: validation.warnings }))
            }

            return {
              result: {
                title: `Saved "${algo.name}" v${algo.version}`,
                output: parts.join("\n"),
                metadata: {
                  algorithmId: algo.algorithmId,
                  name: algo.name,
                  version: algo.version,
                  warningCount: validation.warnings.length,
                  validationAttempts: validation.attempts,
                },
              },
            }
          })

          // Publish the regenerating event, if any. Done in the outer Effect.gen so we
          // have access to Bus.Service. Failures here must not fail the tool call.
          if (outcome.regenEvent) {
            yield* bus.publish(Algorithm.Event.Regenerating, outcome.regenEvent).pipe(Effect.catch(() => Effect.void))
          }

          return outcome.result
        }),
    }
  }),
)
