import type { Tracer } from "@opentelemetry/api"
import type { ModelMessage, TelemetrySettings, Tool } from "ai"
import {
  aiSdkTelemetryPrivacy,
  sanitizeTelemetryPayload,
  telemetryCapturePolicy,
  type SanitizedTelemetryPayload,
} from "@/security/telemetry"
import { sessionTracer } from "@/otel-context"
import { sessionTelemetryAttributes } from "@/telemetry/run-attributes"

function payloadMetadata(prefix: string, payload: SanitizedTelemetryPayload) {
  return {
    [`${prefix}.bytes`]: payload.originalBytes,
    [`${prefix}.sha256`]: payload.sha256,
    [`${prefix}.captured_bytes`]: payload.capturedBytes,
    [`${prefix}.truncated`]: payload.truncated,
    ...(payload.retentionHours === undefined ? {} : { [`${prefix}.retention_hours`]: payload.retentionHours }),
    ...(payload.content === undefined ? {} : { [`${prefix}.content`]: payload.content }),
  }
}

export function modelTelemetry(input: {
  enabled: boolean | undefined
  tracer?: Tracer
  sessionID?: string
  parentSessionID?: string
  userID?: string
  messages: ModelMessage[]
  tools?: Record<string, Tool>
  functionID: string
}): TelemetrySettings {
  const policy = telemetryCapturePolicy()
  const metadata = {
    userId: input.userID ?? "unknown",
    ...(input.sessionID ? { sessionId: input.sessionID } : {}),
    ...(input.sessionID ? sessionTelemetryAttributes(input.sessionID, input.parentSessionID) : {}),
    "finny.prompt.message_count": input.messages.length,
    "finny.prompt.tool_count": Object.keys(input.tools ?? {}).length,
    "finny.payload.capture_enabled": policy.enabled,
  }
  if (!input.enabled) {
    return {
      isEnabled: false,
      ...aiSdkTelemetryPrivacy,
      functionId: input.functionID,
      metadata,
    }
  }
  const messages = sanitizeTelemetryPayload(input.messages, policy)
  const tools = sanitizeTelemetryPayload(input.tools ?? {}, policy)
  return {
    isEnabled: input.enabled,
    ...aiSdkTelemetryPrivacy,
    functionId: input.functionID,
    tracer: input.tracer ? sessionTracer(input.tracer, input.sessionID, input.parentSessionID) : undefined,
    metadata: {
      ...metadata,
      ...payloadMetadata("finny.prompt.messages", messages),
      ...payloadMetadata("finny.prompt.tools", tools),
    },
  }
}
