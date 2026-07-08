import { trace, diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api"
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Log } from "./util/log"

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

let activeProvider: BasicTracerProvider | undefined

if (phoenixEndpoint) {
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto")
  const url = `${phoenixEndpoint.replace(/\/+$/, "")}/v1/traces`
  const exporter = new OTLPTraceExporter({ url })
  const processor = new SimpleSpanProcessor(exporter)
  const provider = new BasicTracerProvider({
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
    spanProcessors: [processor],
  })
  trace.setGlobalTracerProvider(provider)
  activeProvider = provider
}

if (activeProvider) {
  const provider = activeProvider
  process.on("beforeExit", () => {
    flushWithTimeout(provider).catch(() => {})
  })
  const flushAndExit = () => {
    flushWithTimeout(provider)
      .catch(() => {})
      .finally(() => process.exit())
  }
  process.on("SIGINT", flushAndExit)
  process.on("SIGTERM", flushAndExit)
}

export { activeProvider as otelProvider, flushWithTimeout }
