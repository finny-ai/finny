export const NATIVE_HEDGE_SECRET_HEADER = "x-finny-native-hedge-secret"
export const MAX_NATIVE_HEDGE_BATCH = 100

const EVENT_TYPES = new Set([
  "run.started",
  "bar.seen",
  "decision.made",
  "order.intent",
  "order.submitted",
  "order.filled",
  "order.rejected",
  "equity.snapshot",
  "position.snapshot",
  "log",
  "run.stopped",
])
const OPTIONAL_STRING_FIELDS = [
  "algorithmId",
  "algorithmName",
  "symbol",
  "interval",
  "brokerage",
  "mode",
  "orderId",
  "side",
  "status",
  "why",
]
const OPTIONAL_NUMBER_FIELDS = ["qty", "price"]

type EnvLike = { FINNY_NATIVE_HEDGE_SECRET?: string | undefined }
type EventCheck = (value: Record<string, unknown>) => boolean

function defaultEnv(): EnvLike {
  return (globalThis as { process?: { env?: EnvLike } }).process?.env ?? {}
}

function asRecord(input: unknown) {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function optionalNumber(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value))
}

function validOptionalFields(value: Record<string, unknown>, fields: string[], check: (input: unknown) => boolean) {
  return fields.every((field) => check(value[field]))
}

function validEventType(value: unknown) {
  return typeof value === "string" && EVENT_TYPES.has(value)
}

function validSequence(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function validTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
}

const EVENT_CHECKS: EventCheck[] = [
  (value) => nonEmptyString(value.eventId),
  (value) => nonEmptyString(value.runId),
  (value) => validEventType(value.eventType),
  (value) => validSequence(value.sequence),
  (value) => validTimestamp(value.timestamp),
  (value) => validOptionalFields(value, OPTIONAL_STRING_FIELDS, optionalString),
  (value) => validOptionalFields(value, OPTIONAL_NUMBER_FIELDS, optionalNumber),
]

export function nativeHedgeSecret(env: EnvLike = defaultEnv()) {
  return env.FINNY_NATIVE_HEDGE_SECRET?.trim()
}

export function hasValidNativeHedgeSecret(request: Request, env: EnvLike = defaultEnv()) {
  const expected = nativeHedgeSecret(env)
  if (!expected) return false
  return request.headers.get(NATIVE_HEDGE_SECRET_HEADER) === expected
}

export function isNativeHedgeLiveEvent(input: unknown): input is Record<string, unknown> {
  const value = asRecord(input)
  return value !== undefined && EVENT_CHECKS.every((check) => check(value))
}

export function isNativeHedgeIngestPayload(input: unknown): input is { batch: Record<string, unknown>[] } {
  if (!input || typeof input !== "object") return false
  const value = input as Record<string, unknown>
  if (!Array.isArray(value.batch)) return false
  if (value.batch.length === 0 || value.batch.length > MAX_NATIVE_HEDGE_BATCH) return false
  return value.batch.every(isNativeHedgeLiveEvent)
}
