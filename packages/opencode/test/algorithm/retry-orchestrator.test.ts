import { describe, expect, test } from "bun:test"
import { RetryOrchestrator } from "../../src/algorithm/retry-orchestrator"
import type { Validate } from "../../src/algorithm/validate"

const warning = {
  code: "DIVISION_NO_ZERO_CHECK",
  severity: "warning",
  message: "Guard division denominators before dividing.",
} as Validate.Diagnostic

describe("RetryOrchestrator warning handling", () => {
  test("keeps validator warnings advisory instead of promoting them to save blockers", () => {
    const outcome = RetryOrchestrator.outcomeFromValidationResult({
      currentAttempt: 1,
      result: {
        valid: true,
        errors: [],
        warnings: [warning],
      },
    })

    expect(outcome.kind).toBe("passed")
    if (outcome.kind === "passed") {
      expect(outcome.warnings.map((d) => d.code)).toEqual(["DIVISION_NO_ZERO_CHECK"])
    }
  })

  test("warning-only validation does not exhaust the retry budget", () => {
    const outcome = RetryOrchestrator.outcomeFromValidationResult({
      currentAttempt: RetryOrchestrator.MAX_ATTEMPTS,
      result: {
        valid: true,
        errors: [],
        warnings: [warning],
      },
    })

    expect(outcome.kind).toBe("passed")
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

  test("passes when validation has no blocking diagnostics", () => {
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
