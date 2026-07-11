import { httpRouter } from "convex/server"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import {
  hasValidNativeHedgeDashboardSecret,
  hasValidNativeHedgeSecret,
  isNativeHedgeIngestPayload,
} from "./nativeHedgeLiveValidation"

const http = httpRouter()
const HASH_RE = /^[a-f0-9]{64}$/i
const ORG_RE = /^[a-z0-9_-]{1,64}$/
const PAYLOAD_KEYS = new Set(["org_id", "license_key_hash", "machine_id_hash", "app_version", "timestamp"])
const ISSUE_PAYLOAD_KEYS = new Set([
  "org_id",
  "license_key_hash",
  "plan_type",
  "max_devices_per_key",
  "tier",
  "email",
  "source",
  "source_id",
])
const REVOKE_PAYLOAD_KEYS = new Set(["source_id"])

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

function json(input: unknown, status: 200 | 400 | 403 | 500) {
  return new Response(JSON.stringify(input), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function dashboardJson(input: unknown, status: 200 | 403 | 500) {
  return new Response(JSON.stringify(input), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status === 200 ? "private, max-age=10, stale-while-revalidate=20" : "no-store",
    },
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

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function isIssuePayload(input: unknown): input is {
  org_id: string
  license_key_hash: string
  plan_type: "enterprise" | "per_head"
  max_devices_per_key?: number
  tier?: string
  email?: string
  source?: string
  source_id?: string
} {
  if (!input || typeof input !== "object") return false
  const value = input as Record<string, unknown>
  return (
    Object.keys(value).every((key) => ISSUE_PAYLOAD_KEYS.has(key)) &&
    typeof value.org_id === "string" &&
    ORG_RE.test(value.org_id) &&
    typeof value.license_key_hash === "string" &&
    HASH_RE.test(value.license_key_hash) &&
    (value.plan_type === "enterprise" || value.plan_type === "per_head") &&
    (value.max_devices_per_key === undefined ||
      (typeof value.max_devices_per_key === "number" &&
        Number.isInteger(value.max_devices_per_key) &&
        value.max_devices_per_key > 0)) &&
    optionalString(value.tier) &&
    optionalString(value.email) &&
    optionalString(value.source) &&
    optionalString(value.source_id)
  )
}

function isRevokePayload(input: unknown): input is { source_id: string } {
  if (!input || typeof input !== "object") return false
  const value = input as Record<string, unknown>
  return (
    Object.keys(value).every((key) => REVOKE_PAYLOAD_KEYS.has(key)) &&
    typeof value.source_id === "string" &&
    value.source_id.trim().length > 0
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

http.route({
  path: "/license/issue",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!hasValidProxySecret(request)) {
      return denied("verification_failed")
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return json({ ok: false, error_code: "invalid_payload" }, 400)
    }

    if (!isIssuePayload(payload)) {
      return json({ ok: false, error_code: "invalid_payload" }, 400)
    }

    try {
      const result = await ctx.runMutation(internal.licenses.issue, {
        org_id: payload.org_id,
        license_key_hash: payload.license_key_hash,
        plan_type: payload.plan_type,
        max_devices_per_key: payload.max_devices_per_key,
        tier: payload.tier,
        email: payload.email,
        source: payload.source,
        source_id: payload.source_id,
      })
      return json(result, result?.ok ? 200 : 400)
    } catch {
      return json({ ok: false, error_code: "internal_error" }, 500)
    }
  }),
})

http.route({
  path: "/license/revoke",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!hasValidProxySecret(request)) {
      return denied("verification_failed")
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return json({ ok: false, error_code: "invalid_payload" }, 400)
    }

    if (!isRevokePayload(payload)) {
      return json({ ok: false, error_code: "invalid_payload" }, 400)
    }

    try {
      const result = await ctx.runMutation(internal.licenses.revoke, {
        source_id: payload.source_id,
      })
      return json(result, result?.ok ? 200 : 400)
    } catch {
      return json({ ok: false, error_code: "internal_error" }, 500)
    }
  }),
})

http.route({
  path: "/dashboard/native-hedge-live",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!hasValidNativeHedgeDashboardSecret(request)) {
      return dashboardJson({ ok: false, error_code: "verification_failed" }, 403)
    }

    try {
      const snapshot = await ctx.runQuery((internal as any).nativeHedgeLive.dashboardSnapshot, {})
      return dashboardJson({ ok: true, ...snapshot }, 200)
    } catch {
      return dashboardJson({ ok: false, error_code: "internal_error" }, 500)
    }
  }),
})

http.route({
  path: "/ingest/native-hedge-live",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!hasValidNativeHedgeSecret(request)) {
      return denied("verification_failed")
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return json({ ok: false, error_code: "invalid_payload" }, 400)
    }

    if (!isNativeHedgeIngestPayload(payload)) {
      return json({ ok: false, error_code: "invalid_payload" }, 400)
    }

    try {
      const result = await ctx.runMutation((internal as any).nativeHedgeLive.ingest, {
        batch: payload.batch,
      })
      return json(result, result?.ok ? 200 : 400)
    } catch {
      return json({ ok: false, error_code: "internal_error" }, 500)
    }
  }),
})

export default http
