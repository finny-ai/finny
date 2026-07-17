import { afterEach, describe, expect, test } from "bun:test"
import { modelTelemetry } from "@/session/llm/telemetry"
import { jsonSchema, tool, type ModelMessage } from "ai"

describe("model telemetry policy", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
  const tools = {
    lookup: tool({
      description: "lookup a symbol",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
    }),
  }

  test("records bounded message and tool metrics by default", () => {
    const first = modelTelemetry({ enabled: true, messages, tools, functionID: "test" })

    expect(first.recordInputs).toBe(false)
    expect(first.recordOutputs).toBe(false)
    expect(first.metadata?.["finny.prompt.message_count"]).toBe(1)
    expect(first.metadata?.["finny.prompt.tool_count"]).toBe(1)
    expect(first.metadata?.["finny.prompt.messages.bytes"]).toBeGreaterThan(0)
  })

  test("records stable fingerprints and omits payloads by default", () => {
    const first = modelTelemetry({ enabled: true, messages, tools, functionID: "test" })
    const second = modelTelemetry({ enabled: true, messages, tools, functionID: "test" })

    expect(first.metadata?.["finny.prompt.messages.sha256"]).toBe(second.metadata?.["finny.prompt.messages.sha256"])
    expect(first.metadata?.["finny.prompt.tools.sha256"]).toBe(second.metadata?.["finny.prompt.tools.sha256"])
    expect(first.metadata?.["finny.prompt.messages.content"]).toBeUndefined()
    expect(first.metadata?.["finny.payload.capture_enabled"]).toBe(false)
  })

  test("does not construct payload fingerprints when telemetry is disabled", () => {
    const settings = modelTelemetry({ enabled: false, messages, tools, functionID: "test" })

    expect(settings.isEnabled).toBe(false)
    expect(settings.metadata?.["finny.prompt.messages.sha256"]).toBeUndefined()
    expect(settings.metadata?.["finny.prompt.tools.sha256"]).toBeUndefined()
  })

  test("keeps full parent and child session attribution on model spans", () => {
    const settings = modelTelemetry({
      enabled: true,
      sessionID: "child-session",
      parentSessionID: "parent-session",
      messages,
      tools,
      functionID: "test",
    })

    expect(settings.metadata?.["finny.parent_session_id"]).toBe("parent-session")
    expect(settings.metadata?.["finny.child_session_id"]).toBe("child-session")
  })

  test("attaches only sanitizer-approved bounded content and retention metadata", () => {
    process.env.FINNY_OTEL_CAPTURE_PAYLOADS = "1"
    process.env.FINNY_OTEL_PAYLOAD_RETENTION_HOURS = "4"
    process.env.FINNY_OTEL_PAYLOAD_MAX_BYTES = "1024"
    process.env.TEST_API_KEY = "secret-canary-134"

    const settings = modelTelemetry({
      enabled: true,
      messages: [{ role: "user", content: "API_KEY=secret-canary-134" }],
      tools,
      functionID: "test",
    })

    const content = String(settings.metadata?.["finny.prompt.messages.content"])
    expect(settings.recordInputs).toBe(false)
    expect(settings.recordOutputs).toBe(false)
    expect(settings.metadata?.["finny.payload.capture_enabled"]).toBe(true)
    expect(settings.metadata?.["finny.prompt.messages.retention_hours"]).toBe(4)
    expect(settings.metadata?.["finny.prompt.messages.captured_bytes"]).toBeLessThanOrEqual(1024)
    expect(content).not.toContain("secret-canary-134")
    expect(content).toContain("[REDACTED]")
  })
})

afterEach(() => {
  delete process.env.FINNY_OTEL_CAPTURE_PAYLOADS
  delete process.env.FINNY_OTEL_PAYLOAD_RETENTION_HOURS
  delete process.env.FINNY_OTEL_PAYLOAD_MAX_BYTES
  delete process.env.TEST_API_KEY
})
