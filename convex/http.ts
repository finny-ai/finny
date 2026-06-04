import { httpRouter } from "convex/server"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"

const http = httpRouter()
const HASH_RE = /^[a-f0-9]{64}$/i
const ORG_RE = /^[a-z0-9_-]{1,64}$/
const PAYLOAD_KEYS = new Set(["org_id", "license_key_hash", "machine_id_hash", "app_version", "timestamp"])

function requestId() {
  const cryptoApi = globalThis.crypto
  return typeof cryptoApi?.randomUUID === "function" ? cryptoApi.randomUUID() : `${Date.now()}-${Math.random()}`
}

function parseTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function metadata(request: Request) {
  return {
    user_agent: request.headers.get("user-agent")?.slice(0, 240),
    content_type: request.headers.get("content-type")?.slice(0, 80),
    content_length: request.headers.get("content-length")?.slice(0, 32),
  }
}

function json(input: unknown, status: 200 | 403) {
  return new Response(JSON.stringify(input), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function denied(error_code = "verification_failed", message = "Access denied. Please contact Finny.") {
  return json({ ok: false, error_code, message }, 403)
}

function proxySecret() {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.FINNY_LICENSE_PROXY_SECRET?.trim()
}

function hasValidProxySecret(request: Request) {
  const expected = proxySecret()
  if (!expected) return false
  return request.headers.get("x-finny-license-secret") === expected
}

function isPayload(input: unknown): input is {
  org_id: string
  license_key_hash: string
  machine_id_hash: string
  app_version?: string
  timestamp?: string | number
} {
  if (!input || typeof input !== "object") return false
  const value = input as Record<string, unknown>
  return (
    Object.keys(value).every((key) => PAYLOAD_KEYS.has(key)) &&
    typeof value.org_id === "string" &&
    ORG_RE.test(value.org_id) &&
    typeof value.license_key_hash === "string" &&
    HASH_RE.test(value.license_key_hash) &&
    typeof value.machine_id_hash === "string" &&
    HASH_RE.test(value.machine_id_hash) &&
    (value.app_version === undefined || typeof value.app_version === "string")
  )
}

http.route({
  path: "/license/check",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const id = requestId()
    const requestMetadata = metadata(request)

    if (!hasValidProxySecret(request)) {
      return denied("verification_failed")
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return denied("invalid_license")
    }

    if (!isPayload(payload)) {
      return denied("invalid_license")
    }

    try {
      const result = await ctx.runMutation(internal.licenses.check, {
        request_id: id,
        org_id: payload.org_id,
        license_key_hash: payload.license_key_hash,
        machine_id_hash: payload.machine_id_hash,
        app_version: payload.app_version,
        timestamp: parseTimestamp(payload.timestamp),
        metadata: requestMetadata,
      })
      return json(result, result?.ok ? 200 : 403)
    } catch {
      return denied("verification_failed")
    }
  }),
})

export default http
