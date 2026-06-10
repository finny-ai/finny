import { describe, expect, test } from "bun:test"
import { RetryOrchestrator } from "../../src/algorithm/retry-orchestrator"
import type { Validate } from "../../src/algorithm/validate"

const warning = {
  code: "DIVISION_NO_ZERO_CHECK",
  severity: "warning",
  message: "Guard division denominators before dividing.",
} as Validate.Diagnostic

describe("RetryOrchestrator warning handling", () => {
  test("treats validator warnings as retryable save blockers", () => {
    const outcome = RetryOrchestrator.outcomeFromValidationResult({
      currentAttempt: 1,
      result: {
        valid: true,
        errors: [],
        warnings: [warning],
      },
    })

    expect(outcome.kind).toBe("retry")
    if (outcome.kind === "retry") {
      expect(outcome.diagnostics.map((d) => d.code)).toEqual(["DIVISION_NO_ZERO_CHECK"])
      expect(outcome.maxAttempts).toBe(RetryOrchestrator.MAX_ATTEMPTS)
    }
  })

  test("exhausts warning-only retries at the max attempt", () => {
    const outcome = RetryOrchestrator.outcomeFromValidationResult({
      currentAttempt: RetryOrchestrator.MAX_ATTEMPTS,
      result: {
        valid: true,
        errors: [],
        warnings: [warning],
      },
    })

    expect(outcome.kind).toBe("exhausted")
    if (outcome.kind === "exhausted") {
      expect(outcome.report).toContain("Validation rejected: warnings must clear")
      expect(outcome.report).not.toContain("Validation passed")
    }
  })

  test("exhausted message is terminal", () => {
    const output = RetryOrchestrator.buildExhaustedMessage({
      kind: "exhausted",
      attempts: RetryOrchestrator.MAX_ATTEMPTS,
      report: "Validation rejected: warnings must clear before save/backtest.",
    })

    expect(output).toContain("Validation stopped after 3 failed save attempts")
    expect(output).toContain("Do not call finny_algorithm_save again")
    expect(output).toContain("Stop and report")
  })

  test("passes only when validation has zero errors and zero warnings", () => {
    const outcome = RetryOrchestrator.outcomeFromValidationResult({
      currentAttempt: 1,
      result: {
        valid: true,
        errors: [],
        warnings: [],
      },
    })

    expect(outcome.kind).toBe("passed")
  })
})
