import { describe, expect, test, afterEach } from "bun:test"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import {
  _resetValidationGuardForTests,
  recordValidationResult,
  validationFailureCount,
  validationRetryLimitMessage,
  validationRetryLimitReached,
} from "../../src/tool/validation-guard"

function ctx(message = "msg_one"): Tool.Context {
  return {
    sessionID: SessionID.make("ses_validation_guard"),
    messageID: MessageID.make(message),
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Promise.resolve() as any,
    ask: () => Promise.resolve() as any,
  }
}

afterEach(() => {
  _resetValidationGuardForTests()
})

describe("validation guard", () => {
  test("blocks after two failed validations in one message", () => {
    const current = ctx()

    expect(recordValidationResult(current, false)).toBe(1)
    expect(validationRetryLimitReached(current)).toBe(false)

    expect(recordValidationResult(current, false)).toBe(2)
    expect(validationRetryLimitReached(current)).toBe(true)
    expect(validationFailureCount(current)).toBe(2)
    expect(validationRetryLimitMessage()).toContain("BLOCKED: validation retry limit reached")
  })

  test("successful validation clears the failure counter", () => {
    const current = ctx()

    recordValidationResult(current, false)
    expect(validationFailureCount(current)).toBe(1)

    recordValidationResult(current, true)
    expect(validationFailureCount(current)).toBe(0)
    expect(validationRetryLimitReached(current)).toBe(false)
  })

  test("message ids have separate retry budgets", () => {
    const first = ctx("msg_first")
    const second = ctx("msg_second")

    recordValidationResult(first, false)
    recordValidationResult(first, false)

    expect(validationRetryLimitReached(first)).toBe(true)
    expect(validationRetryLimitReached(second)).toBe(false)
  })
})
