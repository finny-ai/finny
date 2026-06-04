import crypto from "crypto"
import { convexClient } from "../storage/convex-client"
import { api as generatedApi } from "../../../../convex/_generated/api"
import { DeviceProfile } from "../device"
import { Log } from "../util/log"

const api = generatedApi as any
const log = Log.create({ service: "analytics-emit" })

const SENSITIVE_KEYS = new Set(["code", "config", "backtestCode", "reasoning", "error", "stderr"])
const MAX_STRING_LEN = 256

function sanitizeValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key)) {
    if (typeof value === "string") return { [`${key}Length`]: value.length }
    return "[redacted]"
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeValue(String(i), item))
  }
  if (typeof value === "object" && value !== null) {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const sanitized = sanitizeValue(k, v)
      if (SENSITIVE_KEYS.has(k)) {
        Object.assign(clean, sanitized)
      } else {
        clean[k] = sanitized
      }
    }
    return clean
  }
  if (typeof value === "string" && value.length > MAX_STRING_LEN) {
    return value.slice(0, MAX_STRING_LEN) + "…"
  }
  return value
}

function sanitizePayload(payload: Record<string, any>): Record<string, any> {
  return sanitizeValue("", payload) as Record<string, any>
}

let deviceIdHash: string | null = null

async function getDeviceIdHash(): Promise<string> {
  if (deviceIdHash) return deviceIdHash
  const device = await DeviceProfile.get()
  const raw = `${device.hostname}-${device.username}`
  deviceIdHash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)
  return deviceIdHash
}

export interface EmitInput {
  eventType: string
  payload: Record<string, any>
  algorithmId?: string
  source?: string
}

export function emit(input: EmitInput): void {
  const work = (async () => {
    try {
      const userId = await DeviceProfile.userId()

      await convexClient().mutation(api.analyticsEvents.track, {
        userId,
        deviceId: await getDeviceIdHash(),
        eventType: input.eventType,
        algorithmId: input.algorithmId,
        payload: sanitizePayload(input.payload),
        timestamp: Date.now(),
        source: input.source,
        appVersion: process.env.npm_package_version,
      })
    } catch (e) {
      log.warn("analytics emit failed (fire-and-forget)", {
        eventType: input.eventType,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })()

  work.catch(() => {})
}
