import { describe, expect, test } from "bun:test"
import { BuildWorkflow } from "@/task/build-workflow"

describe("BuildWorkflow.taskFingerprint", () => {
  test("does not treat discretionary sentiment as mandatory evidence", () => {
    expect(BuildWorkflow.isMandatoryEvidenceRole("data_extractor")).toBe(true)
    expect(BuildWorkflow.isMandatoryEvidenceRole("news_agent")).toBe(true)
    expect(BuildWorkflow.isMandatoryEvidenceRole("sentiment_agent")).toBe(false)
  })

  test("normalizes equivalent mandatory evidence requests", () => {
    const first = BuildWorkflow.taskFingerprint({
      role: "data_extractor",
      prompt: "Extract SPY equity 15-minute data from 2026-01-01 to 2026-06-30 with Alpaca.",
      providerID: "Google",
    })
    const second = BuildWorkflow.taskFingerprint({
      role: "data_extractor",
      prompt: "Please use alpaca for SPY equity 15m bars, 2026-01-01 through 2026-06-30.",
      providerID: "google",
    })
    expect(first).toBe(second)
  })

  test("changes when role, request identity, evidence provider, or model provider changes", () => {
    const base = {
      role: "data_extractor",
      prompt: "Extract SPY equity 15m data from 2026-01-01 to 2026-06-30 with Alpaca.",
      providerID: "google",
    }
    const fingerprint = BuildWorkflow.taskFingerprint(base)
    expect(BuildWorkflow.taskFingerprint({ ...base, role: "news_agent" })).not.toBe(fingerprint)
    expect(BuildWorkflow.taskFingerprint({ ...base, prompt: base.prompt.replace("SPY", "QQQ") })).not.toBe(fingerprint)
    expect(BuildWorkflow.taskFingerprint({ ...base, prompt: base.prompt.replace("Alpaca", "Polygon") })).not.toBe(
      fingerprint,
    )
    expect(BuildWorkflow.taskFingerprint({ ...base, providerID: "openai" })).not.toBe(fingerprint)
  })
})
