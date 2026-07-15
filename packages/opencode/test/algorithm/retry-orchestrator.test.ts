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
      diagnostics: [{ ...warning, fix: "Add a denominator guard." }],
    })

    expect(output).toContain("Failed to save strategy: DIVISION_NO_ZERO_CHECK")
    expect(output).toContain("Fix:")
    expect(output).toContain("Add a denominator guard")
    expect(output).toContain("Automatic fixing stopped after 3 attempts")
    expect(output).not.toContain("Last validator report")
  })

  test("retry message stays compact and puts fixes below causes", () => {
    const output = RetryOrchestrator.buildRetryInstruction({
      kind: "retry",
      attempt: 1,
      maxAttempts: 3,
      report: "large raw validator report that should not be repeated",
      diagnostics: [{ ...warning, line: 42, fix: "Guard the denominator before division." }],
    })
    expect(output).toContain("Failed to save strategy: DIVISION_NO_ZERO_CHECK (line 42) — Guard division denominators")
    expect(output.indexOf("Fix:")).toBeGreaterThan(output.indexOf("Failed to save strategy"))
    expect(output).toContain("Automatic fix attempt 1/3")
    expect(output).not.toContain("large raw validator report")
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
