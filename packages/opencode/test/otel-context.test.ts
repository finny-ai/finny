import { describe, expect, test } from "bun:test"
import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { installAsyncContextManager, sessionTracer } from "@/otel-context"

installAsyncContextManager()

async function cancelModelSpan(model: Span): Promise<void> {
  const controller = new AbortController()
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => {
      model.setStatus({ code: SpanStatusCode.ERROR, message: "cancelled" })
      model.end()
      resolve()
    })
    controller.abort()
  })
}

async function runNestedSpans(tracer: Tracer): Promise<void> {
  await tracer.startActiveSpan("turn", async (turn) => {
    await Promise.resolve()
    await tracer.startActiveSpan("model", async (model) => cancelModelSpan(model))
    turn.end()
  })
}

function expectSpanTree(
  turn: ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number] | undefined,
  model: ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number] | undefined,
): void {
  expect(turn).toBeDefined()
  expect(model).toBeDefined()
  expect(model?.spanContext().traceId).toBe(turn?.spanContext().traceId)
  expect(model?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId)
}

function expectModelAttribution(model: ReturnType<InMemorySpanExporter["getFinishedSpans"]>[number] | undefined): void {
  expect(model?.attributes["session.id"]).toBe("session-1")
  expect(model?.attributes["finny.parent_session_id"]).toBe("parent-session")
  expect(model?.attributes["finny.child_session_id"]).toBe("session-1")
  expect(model?.status).toEqual({ code: SpanStatusCode.ERROR, message: "cancelled" })
}

function expectNestedSpanTree(exporter: InMemorySpanExporter): void {
  const spans = exporter.getFinishedSpans()
  const turn = spans.find((span) => span.name === "turn")
  const model = spans.find((span) => span.name === "model")
  expectSpanTree(turn, model)
  expectModelAttribution(model)
}

describe("OpenTelemetry async context", () => {
  test("keeps nested async spans in one trace tree and preserves terminal state", async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    const tracer = sessionTracer(provider.getTracer("test"), "session-1", "parent-session")

    await runNestedSpans(tracer)
    expectNestedSpanTree(exporter)
  })
})
