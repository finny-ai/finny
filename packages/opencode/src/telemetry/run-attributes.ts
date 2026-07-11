export function runTelemetryAttributes(): Record<string, string> {
  const attributes: Record<string, string> = { "service.name": "finny" }
  const runId = process.env.FINNY_RUN_ID
  const commit = process.env.FINNY_GIT_COMMIT
  const project = process.env.PHOENIX_PROJECT
  if (runId) attributes["finny.run_id"] = runId
  if (commit) attributes["git.commit"] = commit
  if (project) attributes["openinference.project.name"] = project
  return attributes
}

export function sessionTelemetryAttributes(sessionId: string, parentSessionId?: string): Record<string, string> {
  const mainSessionId = process.env.FINNY_MAIN_SESSION_ID ?? (parentSessionId ? undefined : sessionId)
  return {
    "session.id": sessionId,
    "finny.session_id": sessionId,
    ...(mainSessionId ? { "finny.main_session_id": mainSessionId } : {}),
    ...(parentSessionId ? { "finny.parent_session_id": parentSessionId } : {}),
    ...(parentSessionId ? { "finny.child_session_id": sessionId } : {}),
  }
}

export function otelResourceAttributes(): string {
  return Object.entries(runTelemetryAttributes())
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join(",")
}

export function withTelemetrySpan(name: string, attributes: Attributes) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => trace.getTracer("finny.runtime").startSpan(name, { attributes })),
      () => effect,
      (span) => Effect.sync(() => span.end()),
    )
}

export function acquireTelemetrySpan(name: string, attributes: Attributes) {
  return Effect.acquireRelease(
    Effect.sync(() => trace.getTracer("finny.runtime").startSpan(name, { attributes })),
    (span) => Effect.sync(() => span.end()),
  )
}
import { trace, type Attributes } from "@opentelemetry/api"
import { Effect } from "effect"
