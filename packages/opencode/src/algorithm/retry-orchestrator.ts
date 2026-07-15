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
    /** Structured blockers from the final attempt. */
    diagnostics: Validate.Diagnostic[]
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
    const blockingDiagnostics = Validate.blockingDiagnostics(result)
    const advisoryDiagnostics = Validate.advisoryDiagnostics(result)
    if (blockingDiagnostics.length === 0) {
      return { kind: "passed", attempts: currentAttempt, warnings: advisoryDiagnostics }
    }

    const report = Validate.format(result)

    if (currentAttempt >= MAX_ATTEMPTS) {
      return { kind: "exhausted", attempts: currentAttempt, report, diagnostics: blockingDiagnostics }
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
    return [
      formatSaveFailure(signal.diagnostics),
      `Automatic fix attempt ${signal.attempt}/${signal.maxAttempts}: correct the strategy and call finny_algorithm_save again.`,
    ].join("\n")
  }

  /** Compact user/agent-facing failure: causes first, then concrete fixes. */
  export function formatSaveFailure(diagnostics: Validate.Diagnostic[]): string {
    if (diagnostics.length === 0) return "Failed to save strategy: validation did not return a specific cause.\nFix: review the strategy contract and retry."
    if (diagnostics.length === 1) {
      const diagnostic = diagnostics[0]
      const loc = diagnostic.line ? ` (line ${diagnostic.line})` : ""
      return [
        `Failed to save strategy: ${diagnostic.code}${loc} — ${diagnostic.message}`,
        `Fix: ${diagnostic.fix ?? "Correct this validator error, then retry."}`,
      ].join("\n")
    }
    const causes = diagnostics.map((d) => {
      const loc = d.line ? ` (line ${d.line})` : ""
      return `- ${d.code}${loc}: ${d.message}`
    })
    const fixes = diagnostics.map((d) => `- ${d.code}: ${d.fix ?? "Correct this validator error, then retry."}`)
    return [
      `Failed to save strategy because validation found ${diagnostics.length} blocking issues:`,
      ...causes,
      `Fix:`,
      ...fixes,
    ].join("\n")
  }

  export function formatWarningRejection(warnings: Validate.Diagnostic[]): string {
    const lines = warnings.map((d) => {
      const loc = d.line ? ` (line ${d.line})` : ""
      const fix = d.fix ? `\n  Fix: ${d.fix}` : ""
      return `- ${d.code}${loc}: ${d.message}${fix}`
    })

    return [
      `Validation advisory warnings:`,
      ``,
      `${warnings.length} warning(s):`,
      ...lines,
    ].join("\n")
  }

  export function buildExhaustedMessage(signal: ExhaustedSignal): string {
    return [
      formatSaveFailure(signal.diagnostics),
      `Automatic fixing stopped after ${signal.attempts} attempts. Do not retry this save again in the current request.`,
    ].join("\n")
  }
}
