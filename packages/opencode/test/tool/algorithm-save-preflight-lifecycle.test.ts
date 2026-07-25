import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import {
  _resetSavePreflightGuardForTests,
  recordSavePreflightFailure,
  savePreflightRetryMessage,
} from "../../src/tool/algorithm-save"

afterEach(() => _resetSavePreflightGuardForTests())

test("document/config preflight precedes durable save-attempt registration", () => {
  const source = fs.readFileSync(new URL("../../src/tool/algorithm-save.ts", import.meta.url), "utf8")
  const execute = source.slice(
    source.indexOf("const documents = resolveSaveDocuments"),
    source.indexOf("const outcomeExit"),
  )
  const contractGate = execute.indexOf("const contractBlock = contractRejectionBlock")
  const durableRegistration = execute.indexOf("const durableStart")
  expect(contractGate).toBeGreaterThanOrEqual(0)
  expect(durableRegistration).toBeGreaterThan(contractGate)
  expect(execute.indexOf("if (contractBlock) return contractBlock")).toBeLessThan(durableRegistration)
})

test("unchanged save contract failures are hard-bounded with the exact docsMode correction", () => {
  const fingerprint = "same-version-save"
  const issues = ['docsMode "inherit" cannot replace mission, preferences, or riskContract; use docsMode: "replace"']

  const first = recordSavePreflightFailure("ses_preflight", fingerprint)
  expect(first).toBe(1)
  expect(savePreflightRetryMessage(first, issues)).toContain('change docsMode from "inherit" to "replace"')
  expect(savePreflightRetryMessage(first, issues)).toContain("one retry maximum")

  const second = recordSavePreflightFailure("ses_preflight", fingerprint)
  expect(second).toBe(2)
  expect(savePreflightRetryMessage(second, issues)).toContain("BLOCKED: save preflight retry limit reached (2/2)")
  expect(savePreflightRetryMessage(second, issues)).toContain('Do not call finny_algorithm_save again with docsMode "inherit"')
})

test("a changed save contract fingerprint gets a fresh bounded retry budget", () => {
  expect(recordSavePreflightFailure("ses_preflight", "inherit-payload")).toBe(1)
  expect(recordSavePreflightFailure("ses_preflight", "replace-payload")).toBe(1)
})
