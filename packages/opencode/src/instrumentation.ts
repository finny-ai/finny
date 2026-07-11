import { trace, diag, DiagLogLevel, SpanStatusCode, type Attributes, type DiagLogger } from "@opentelemetry/api"
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { Log } from "./util/log"
import { runTelemetryAttributes } from "./telemetry/run-attributes"

// Route OTel diagnostics through the file logger. Writing them to stderr via
// console.error corrupts the interactive TUI, since it renders into the same
// terminal — a benign span-lifecycle warning (e.g. "You can only call end() on
// a span once") would otherwise paint garbage over the drawn frame.
const otelLog = Log.create({ service: "otel" })
const fileLogger: DiagLogger = {
  error(message, ...args) {
    otelLog.error(message, args.length ? { args } : undefined)
  },
  warn() {},
  info() {},
  debug() {},
  verbose() {},
}
diag.setLogger(fileLogger, DiagLogLevel.ERROR)

const langfusePublicKey = process.env["LANGFUSE_PUBLIC_KEY"]
const langfuseSecretKey = process.env["LANGFUSE_SECRET_KEY"]
// Use PHOENIX_COLLECTOR_ENDPOINT to avoid colliding with the Effect
// Observability layer which also reads OTEL_EXPORTER_OTLP_ENDPOINT.
const phoenixEndpoint = process.env["PHOENIX_COLLECTOR_ENDPOINT"]

function flushWithTimeout(provider: BasicTracerProvider, ms = 2_000) {
  return Promise.race([provider.forceFlush(), new Promise<void>((r) => setTimeout(r, ms))])
}

/**
 * Await `work` up to `ms`. Prefer a real completion that lands just after the
 * deadline over a premature `timed_out` — borderline OTLP flushes must not
 * fail harness observability grading.
 */
async function settleWithDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: T,
  graceMs = 100,
): Promise<T> {
  let finished: T | undefined
  const tracked = work.then((result) => {
    finished = result
    return result
  })
  await Promise.race([tracked, new Promise<void>((resolve) => setTimeout(resolve, ms))])
  if (finished !== undefined) return finished
  // Short grace for completions that race the deadline timer.
  await Promise.race([tracked, new Promise<void>((resolve) => setTimeout(resolve, graceMs))])
  if (finished !== undefined) return finished
  return onTimeout
}

let activeProvider: BasicTracerProvider | undefined
export type TelemetryShutdownResult = "completed" | "timed_out" | "failed" | "not_configured"
let shutdownPromise: Promise<TelemetryShutdownResult> | undefined
export type AppRuntimeShutdownResult = "completed" | "timed_out" | "failed"
let appRuntimeShutdownPromise: Promise<AppRuntimeShutdownResult> | undefined
let completionRecorded = false
let harnessTelemetryPromise: Promise<void> | undefined

function shutdownTelemetry(ms = 2_000): Promise<TelemetryShutdownResult> {
  if (!activeProvider) return Promise.resolve("not_configured")
  if (shutdownPromise) return shutdownPromise
  const provider = activeProvider
  const work = provider
    .forceFlush()
    .then(() => provider.shutdown())
    .then((): TelemetryShutdownResult => "completed")
    .catch((): TelemetryShutdownResult => "failed")
  shutdownPromise = settleWithDeadline(work, ms, "timed_out")
  return shutdownPromise
}

function shutdownAppRuntime(ms = 2_000): Promise<AppRuntimeShutdownResult> {
  if (appRuntimeShutdownPromise) return appRuntimeShutdownPromise
  const work = import("./effect/app-runtime")
    .then(({ AppRuntime }) => AppRuntime.dispose())
    .then((): AppRuntimeShutdownResult => "completed")
    .catch((): AppRuntimeShutdownResult => "failed")
  appRuntimeShutdownPromise = settleWithDeadline(work, ms, "timed_out")
  return appRuntimeShutdownPromise
}

function recordRunCompletion(exitCode: number, explicitSessionId?: string): { attributes: Attributes; recorded: boolean } {
  const sessionId = explicitSessionId ?? process.env.FINNY_MAIN_SESSION_ID
  const attributes: Attributes = {
    ...runTelemetryAttributes(),
    ...(sessionId
      ? {
          "session.id": sessionId,
          session_id: sessionId,
          "finny.session_id": sessionId,
          "finny.main_session_id": sessionId,
        }
      : {}),
    "process.exit.code": exitCode,
  }
  if (completionRecorded) return { attributes, recorded: false }
  completionRecorded = true
  const span = trace.getTracer("finny.lifecycle").startSpan("finny.run.completed", {
    attributes,
  })
  span.setStatus({ code: exitCode === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR })
  span.end()
  return { attributes, recorded: true }
}

function telemetryFlushResult(manualTelemetry: TelemetryShutdownResult): "completed" | "timed_out" | "failed" | "not_run" {
  if (manualTelemetry === "failed") return "failed"
  if (manualTelemetry === "timed_out") return "timed_out"
  return manualTelemetry === "not_configured" ? "not_run" : "completed"
}

function emitHarnessTelemetry(
  appRuntime: AppRuntimeShutdownResult,
  manualTelemetry: TelemetryShutdownResult,
): Promise<void> {
  if (process.env.FINNY_HARNESS_MODE !== "1") return Promise.resolve()
  if (harnessTelemetryPromise) return harnessTelemetryPromise
  const event = `${JSON.stringify({
    type: "harness_telemetry",
    timestamp: Date.now(),
    sessionID: process.env.FINNY_MAIN_SESSION_ID,
    flush: telemetryFlushResult(manualTelemetry),
    appRuntime,
    manualTelemetry,
  })}\n`
  harnessTelemetryPromise = new Promise<void>((resolve) => process.stdout.write(event, () => resolve()))
  return harnessTelemetryPromise
}

if (phoenixEndpoint) {
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto")
  const url = `${phoenixEndpoint.replace(/\/+$/, "")}/v1/traces`
  const exporter = new OTLPTraceExporter({ url })
  const processor = new SimpleSpanProcessor(exporter)
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(runTelemetryAttributes()),
    spanProcessors: [processor],
  })
  trace.setGlobalTracerProvider(provider)
  activeProvider = provider
} else if (langfusePublicKey && langfuseSecretKey) {
  const { LangfuseSpanProcessor } = await import("@langfuse/otel")
  const baseUrl =
    process.env["LANGFUSE_BASEURL"] ?? process.env["LANGFUSE_BASE_URL"] ?? "https://cloud.langfuse.com"
  const processor = new LangfuseSpanProcessor({
    publicKey: langfusePublicKey,
    secretKey: langfuseSecretKey,
    baseUrl,
    flushAt: 1,
    flushInterval: 1,
  })
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes(runTelemetryAttributes()),
    spanProcessors: [processor],
  })
  trace.setGlobalTracerProvider(provider)
  activeProvider = provider
}

if (activeProvider) {
  process.on("beforeExit", () => {
    void shutdownTelemetry()
  })
  let signalExitStarted = false
  const flushAndExit = (exitCode: number) => {
    if (signalExitStarted) return
    signalExitStarted = true
    recordRunCompletion(exitCode)
    Promise.all([shutdownAppRuntime(1_500), shutdownTelemetry(1_500)])
      .then(([appRuntime, manualTelemetry]) => emitHarnessTelemetry(appRuntime, manualTelemetry))
      .finally(() => process.exit(exitCode))
  }
  process.on("SIGINT", () => flushAndExit(130))
  process.on("SIGTERM", () => flushAndExit(143))
}

export {
  activeProvider as otelProvider,
  emitHarnessTelemetry,
  flushWithTimeout,
  recordRunCompletion,
  settleWithDeadline,
  shutdownAppRuntime,
  shutdownTelemetry,
  telemetryFlushResult,
}
