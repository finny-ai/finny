import { Validate } from "./validate"

/**
 * Tracks validation retry attempts for algorithm generation.
 *
 * The flow:
 *   1. Agent calls finny_algorithm_save with generated code.
 *   2. Validator runs; if it passes, save proceeds and the counter resets.
 *   3. If validation fails, we increment the per-session-per-algo counter and
 *      return a structured response telling the agent to rewrite. The response
 *      is marked `transient: true` so the TUI suppresses it — the user only
 *      ever sees the final, validated algorithm.
 *   4. After MAX_ATTEMPTS consecutive failures, we surface a clean user-facing
 *      error and reset the counter so the next user request starts fresh.
 *
 * Version stability is a natural consequence of this flow: Algorithm.save() is
 * only called on a passing validation, so `existing.version + 1` never advances
 * for rejected attempts. v1 stays v1 until the agent produces valid code.
 */
export namespace RetryOrchestrator {
  export const MAX_ATTEMPTS = 3

  /** In-process attempt counter. Key: `${sessionID}::${algorithmName}`. */
  const attempts = new Map<string, number>()

  function key(sessionID: string, algorithmName: string): string {
    return `${sessionID}::${algorithmName}`
  }

  export interface RetrySignal {
    kind: "retry"
    attempt: number
    maxAttempts: number
    /** Human-readable validation report — gets fed back to the LLM. */
    report: string
    /** Structured error list so the LLM can target fixes. */
    diagnostics: Validate.Diagnostic[]
  }

  export interface ExhaustedSignal {
    kind: "exhausted"
    attempts: number
    /** Final report from the last failed attempt. */
    report: string
  }

  export interface PassedSignal {
    kind: "passed"
    /** Number of attempts it took — 1 means first try. */
    attempts: number
    warnings: Validate.Diagnostic[]
  }

  export type Outcome = RetrySignal | ExhaustedSignal | PassedSignal

  export function outcomeFromValidationResult(input: {
    result: Validate.Result
    currentAttempt: number
  }): Outcome {
    const { result, currentAttempt } = input
    if (result.valid && result.warnings.length === 0) {
      return { kind: "passed", attempts: currentAttempt, warnings: [] }
    }

    const report = result.valid && result.warnings.length > 0 ? formatWarningRejection(result.warnings) : Validate.format(result)
    const blockingDiagnostics = [...result.errors, ...result.warnings]

    if (currentAttempt >= MAX_ATTEMPTS) {
      return { kind: "exhausted", attempts: currentAttempt, report }
    }

    return {
      kind: "retry",
      attempt: currentAttempt,
      maxAttempts: MAX_ATTEMPTS,
      report,
      diagnostics: blockingDiagnostics,
    }
  }

  /**
   * Run validation and decide what the save tool should do next.
   * Never mutates storage — that's the caller's job once `kind === "passed"`.
   */
  export async function attempt(input: {
    sessionID: string
    algorithmName: string
    code: string
    config?: string | Record<string, unknown>
  }): Promise<Outcome> {
    const k = key(input.sessionID, input.algorithmName)
    const priorAttempts = attempts.get(k) ?? 0
    const currentAttempt = priorAttempts + 1

    const result = await Validate.run(input.code, { config: input.config })
    const outcome = outcomeFromValidationResult({ result, currentAttempt })

    if (outcome.kind === "passed" || outcome.kind === "exhausted") {
      // Success or terminal failure — clear counter for this algo.
      attempts.delete(k)
      return outcome
    }

    attempts.set(k, currentAttempt)
    return outcome
  }

  /**
   * Force-reset the counter for an algorithm. Call when a new user request
   * explicitly supersedes any in-flight generation, or in tests.
   */
  export function reset(sessionID: string, algorithmName: string): void {
    attempts.delete(key(sessionID, algorithmName))
  }

  /** Inspect the current attempt count. Primarily for tests / telemetry. */
  export function currentAttempts(sessionID: string, algorithmName: string): number {
    return attempts.get(key(sessionID, algorithmName)) ?? 0
  }

  /**
   * Build the synthetic instruction the LLM sees on retry. Kept separate so
   * the prompt can evolve without touching the orchestrator state machine.
   */
  export function buildRetryInstruction(signal: RetrySignal): string {
    const diagnostics = signal.diagnostics.map((d) => {
      const loc = d.line ? ` (line ${d.line})` : ""
      const fix = d.fix ? `  Fix: ${d.fix}` : ""
      return `- ${d.code}${loc}: ${d.message}\n${fix}`
    }).join("\n")

    return [
      `Validation rejected attempt ${signal.attempt}/${signal.maxAttempts}.`,
      ``,
      `Blocking diagnostics:`,
      diagnostics,
      ``,
      `Rewrite the full strategy fixing every error. Do not apologise. Do not narrate.`,
      `Call finny_algorithm_save again with the corrected code.`,
    ].join("\n")
  }

  export function formatWarningRejection(warnings: Validate.Diagnostic[]): string {
    const lines = warnings.map((d) => {
      const loc = d.line ? ` (line ${d.line})` : ""
      const fix = d.fix ? `\n  Fix: ${d.fix}` : ""
      return `- ${d.code}${loc}: ${d.message}${fix}`
    })

    return [
      `Validation rejected: warnings must clear before save/backtest.`,
      ``,
      `${warnings.length} warning(s):`,
      ...lines,
    ].join("\n")
  }

  export function buildExhaustedMessage(signal: ExhaustedSignal): string {
    return [
      `Validation stopped after ${signal.attempts} failed save attempts.`,
      ``,
      `Do not call finny_algorithm_save again for this request. Stop and report the final validator blockers to the user.`,
      ``,
      `Last validator report:`,
      signal.report,
    ].join("\n")
  }
}
