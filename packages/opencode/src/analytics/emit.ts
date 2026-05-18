import crypto from "crypto"
import { convexClient } from "../storage/convex-client"
import { api } from "../../../../convex/_generated/api"
import { DeviceProfile } from "../device"
import { Log } from "../util/log"

const log = Log.create({ service: "analytics-emit" })

const SENSITIVE_KEYS = new Set(["code", "config", "backtestCode", "reasoning", "error", "stderr"])
const MAX_STRING_LEN = 256

function sanitizePayload(payload: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.has(k)) {
      if (typeof v === "string") {
        clean[`${k}Length`] = v.length
      }
      continue
    }
    if (typeof v === "string" && v.length > MAX_STRING_LEN) {
      clean[k] = v.slice(0, MAX_STRING_LEN) + "…"
    } else {
      clean[k] = v
    }
  }
  return clean
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
