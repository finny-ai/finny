import { context, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { sessionTelemetryAttributes } from "@/telemetry/run-attributes"

let installed = false
let firstRootSpan: Span | undefined

export function installAsyncContextManager() {
  if (installed) return
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)
  installed = true
}

function sessionOptions(sessionID: string, parentSessionID: string | undefined, value: SpanOptions = {}): SpanOptions {
  return {
    ...value,
    attributes: { ...value.attributes, ...sessionTelemetryAttributes(sessionID, parentSessionID) },
  }
}

function decorateSpan(sessionID: string, parentSessionID: string | undefined, value: Span): Span {
  value.setAttributes(sessionTelemetryAttributes(sessionID, parentSessionID))
  return value
}

function startSessionSpan(
  tracer: Tracer,
  input: {
    sessionID: string
    parentSessionID?: string
    name: string
    value?: SpanOptions
    ctx?: Parameters<Tracer["startSpan"]>[2]
  },
): Span {
  const created = decorateSpan(
    input.sessionID,
    input.parentSessionID,
    tracer.startSpan(input.name, sessionOptions(input.sessionID, input.parentSessionID, input.value), input.ctx),
  )
  if (firstRootSpan === undefined && input.ctx === undefined) firstRootSpan = created
  return created
}

function startSessionActiveSpan(
  tracer: Tracer,
  input: {
    sessionID: string
    parentSessionID?: string
    name: string
    args: unknown[]
  },
): unknown {
  const callbackIndex = input.args.length - 1
  // OpenTelemetry exposes startActiveSpan through overloads; normalize the
  // overloads here so options and callback decoration stay deterministic.
  const callback = input.args[callbackIndex] as (active: Span) => unknown
  input.args[callbackIndex] = (active: Span) => callback(decorateSpan(input.sessionID, input.parentSessionID, active))
  if (input.args.length >= 2 && typeof input.args[0] === "object")
    input.args[0] = sessionOptions(input.sessionID, input.parentSessionID, input.args[0] as SpanOptions)
  else if (input.args.length === 1) input.args.unshift(sessionOptions(input.sessionID, input.parentSessionID))
  return (tracer.startActiveSpan as (...values: unknown[]) => unknown)(input.name, ...input.args)
}

export function sessionTracer(tracer: Tracer, sessionID?: string, parentSessionID?: string): Tracer {
  if (!sessionID) return tracer

  return new Proxy(tracer, {
    get(target, prop) {
      if (prop === "startSpan") {
        return (name: string, value?: SpanOptions, ctx?: Parameters<Tracer["startSpan"]>[2]) =>
          startSessionSpan(target, { sessionID, parentSessionID, name, value, ctx })
      }
      if (prop === "startActiveSpan") {
        return (name: string, ...args: unknown[]) =>
          startSessionActiveSpan(target, { sessionID, parentSessionID, name, args })
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** The first root span for this process, used to parent terminal lifecycle data. */
export function rootSpan(): Span | undefined {
  return firstRootSpan
}
