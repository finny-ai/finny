/**
 * Shared OTEL / AI SDK privacy contract.
 *
 * Integration rules (issue #140 boundary for issue #134 and any future span work):
 * - Always spread `aiSdkTelemetryPrivacy` into AI SDK `experimental_telemetry`
 *   so raw prompt/completion attributes stay off.
 * - Never attach raw model messages, tool args, or shell transcripts as span
 *   attributes. Call `sanitizeTelemetryPayload` only.
 * - Debug content is opt-in via env (see `telemetryCapturePolicy`); default is
 *   metadata-only (sha256 + sizes).
 */
import { createHash } from "node:crypto"
import { redactSensitiveOutput } from "./worker-shell"

/** Env contract for operators enabling debug payload capture. */
export const TELEMETRY_PAYLOAD_ENV = {
  /** Must be exactly "1" to enable content capture. */
  enable: "FINNY_OTEL_CAPTURE_PAYLOADS",
  /** Required integer hours in [1, 24] when capture is enabled. */
  retentionHours: "FINNY_OTEL_PAYLOAD_RETENTION_HOURS",
  /** Optional per-payload cap in bytes; cannot exceed 32 KiB. */
  maxBytes: "FINNY_OTEL_PAYLOAD_MAX_BYTES",
} as const

export const aiSdkTelemetryPrivacy = {
  // AI SDK otherwise records prompts and completions as span attributes. Those
  // attributes can include replayed tool history and are not safe to export.
  recordInputs: false,
  recordOutputs: false,
} as const

const MAX_CAPTURE_BYTES = 32 * 1024
const MAX_RETENTION_HOURS = 24
const SENSITIVE_KEY_RE = /(?:api.?key|auth|broker.?key|credential|passphrase|password|secret|token)/i

export type TelemetryCapturePolicy =
  | { enabled: false }
  | { enabled: true; retentionHours: number; maxBytes: number }

export type SanitizedTelemetryPayload = {
  sha256: string
  originalBytes: number
  capturedBytes: number
  truncated: boolean
  retentionHours?: number
  content?: string
}

function boundedInteger(value: string | undefined, maximum: number) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return
  if (parsed < 1 || parsed > maximum) return
  return parsed
}

function captureMaxBytes(value: string | undefined) {
  if (value === undefined) return MAX_CAPTURE_BYTES
  return boundedInteger(value, MAX_CAPTURE_BYTES) ?? MAX_CAPTURE_BYTES
}

export function telemetryCapturePolicy(env: NodeJS.ProcessEnv = process.env): TelemetryCapturePolicy {
  if (env[TELEMETRY_PAYLOAD_ENV.enable] !== "1") return { enabled: false }
  const retentionHours = boundedInteger(env[TELEMETRY_PAYLOAD_ENV.retentionHours], MAX_RETENTION_HOURS)
  if (retentionHours === undefined) return { enabled: false }
  return {
    enabled: true,
    retentionHours,
    maxBytes: captureMaxBytes(env[TELEMETRY_PAYLOAD_ENV.maxBytes]),
  }
}

function sanitizedValue(value: unknown, env: NodeJS.ProcessEnv, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveOutput({ text: value, env })
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => sanitizedValue(item, env, seen))
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : sanitizedValue(item, env, seen)]),
  )
}

function stablePayload(value: unknown, env: NodeJS.ProcessEnv) {
  const sanitized = sanitizedValue(value, env, new WeakSet())
  if (typeof sanitized === "string") return sanitized
  return JSON.stringify(sanitized) ?? String(sanitized)
}

export function sanitizeTelemetryPayload(
  payload: unknown,
  policy: TelemetryCapturePolicy = telemetryCapturePolicy(),
  env: NodeJS.ProcessEnv = process.env,
): SanitizedTelemetryPayload {
  let raw: string
  try {
    raw = typeof payload === "string" ? payload : JSON.stringify(payload) ?? String(payload)
  } catch {
    raw = String(payload)
  }
  const originalBytes = Buffer.byteLength(raw)
  const sha256 = createHash("sha256").update(raw).digest("hex")
  if (!policy.enabled) return { sha256, originalBytes, capturedBytes: 0, truncated: false }

  const safe = stablePayload(payload, env)
  const encoded = new TextEncoder().encode(safe)
  const truncated = encoded.byteLength > policy.maxBytes
  let content = new TextDecoder().decode(truncated ? encoded.slice(0, policy.maxBytes) : encoded)
  while (Buffer.byteLength(content) > policy.maxBytes) {
    content = content.slice(0, -1)
  }
  return {
    sha256,
    originalBytes,
    capturedBytes: Buffer.byteLength(content),
    truncated,
    retentionHours: policy.retentionHours,
    content,
  }
}
