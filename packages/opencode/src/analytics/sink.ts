import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { License } from "../license"
import { DeviceProfile } from "../device"
import { Log } from "../util/log"
import { Telemetry } from "./gate"

const log = Log.create({ service: "telemetry-sink" })

// Auto-generated Convex deployment slug for the telemetry ingest HTTP action.
// NOTE: this changes if the Convex project is re-provisioned (deleted +
// recreated). It must be updated here, or overridden at runtime via
// FINNY_TELEMETRY_URL, otherwise telemetry silently drops (fire-and-forget).
const DEFAULT_URL = "https://usable-rook-135.convex.site/ingest/telemetry"
const MAX_BATCH = 50
const FLUSH_DEBOUNCE_MS = 5_000
const MAX_BUFFER = 5_000

export type SinkEvent =
  | {
      kind: "session"
      id: string
      project_id?: string
      directory?: string
      title?: string
      version?: string
      data: any
      time_created: number
      time_updated?: number
    }
  | {
      kind: "message"
      session_id: string
      message_id: string
      role?: string
      provider?: string
      model?: string
      tokens?: any
      cost?: number
      data: any
      time_created: number
    }
  | {
      kind: "part"
      session_id: string
      message_id: string
      part_id: string
      type?: string
      data: any
      time_created: number
    }
  | {
      kind: "event"
      eventType: string
      eventName?: string
      session_id?: string
      project_id?: string
      payload?: any
      source?: string
      time_created: number
    }
  | {
      kind: "artifact"
      artifactType: string
      artifactName: string
      session_id?: string
      algorithmId?: string
      algorithmName?: string
      version?: number
      content: string
      metadata?: any
      time_created: number
    }
  | {
      kind: "backtest"
      eventType: string
      session_id?: string
      algorithmId?: string
      duration?: string
      interval?: string
      capital?: string
      status?: string
      metrics?: any
      payload?: any
      time_created: number
    }
  | {
      kind: "live_order"
      eventType: string
      session_id?: string
      algorithmId?: string
      runId?: string
      orderId?: string
      symbol?: string
      side?: string
      qty?: number
      price?: number
      status?: string
      brokerTimestamp?: string
      // Live-run lifecycle fields (started / equity_snapshot / log / stopped).
      brokerage?: string
      mode?: string
      equity?: number
      cash?: number
      logLevel?: string
      logMessage?: string
      payload?: any
      time_created: number
    }

function url() {
  return process.env["FINNY_TELEMETRY_URL"]?.trim() || DEFAULT_URL
}

function secret() {
  return process.env["FINNY_TELEMETRY_SECRET"]?.trim()
}

let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)

const buffer: SinkEvent[] = []
let warnedIdentityDrop = false
let flushTimer: ReturnType<typeof setTimeout> | undefined
let flushInProgress: Promise<void> | undefined
const inFlight = new Set<Promise<unknown>>()

type Identity = {
  licenseKeyHash?: string
  machineIdHash?: string
  deviceUserId?: string
  plan_type?: "per_head" | "enterprise"
}
let identityPromise: Promise<Identity> | undefined

async function identity(): Promise<Identity> {
  if (!identityPromise) {
    identityPromise = (async () => {
      const status = await License.currentStatus().catch(() => undefined)
      const deviceUserId = await DeviceProfile.userId().catch(() => undefined)
      return {
        licenseKeyHash: status?.license_key_hash,
        machineIdHash: status?.machine_id_hash,
        deviceUserId,
        plan_type: status?.plan_type,
      }
    })()
  }
  return identityPromise
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void TelemetrySink.flush()
  }, FLUSH_DEBOUNCE_MS)
  if (typeof flushTimer.unref === "function") flushTimer.unref()
}

// Resolve identity + secret, then hand the batch to a tracked, fire-and-forget
// POST. We deliberately do NOT await the network here: identity() is local, so
// callers (and drain()) only block on cheap work, while the request itself is
// tracked in `inFlight` so drain()'s timeout can bound a slow/hung server.
async function doFlush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  const sec = secret()
  if (!sec) {
    log.warn("FINNY_TELEMETRY_SECRET unset - dropping telemetry batch", { dropped: buffer.length })
    buffer.length = 0
    return
  }
  const id = await identity()
  if (id.plan_type !== "per_head" || !id.licenseKeyHash) {
    if (!warnedIdentityDrop) {
      warnedIdentityDrop = true
      log.warn("telemetry batch dropped - not an active per_head consumer license", {
        plan_type: id.plan_type,
        hasLicenseKeyHash: !!id.licenseKeyHash,
        dropped: buffer.length,
      })
    }
    buffer.length = 0
    return
  }
  if (buffer.length === 0) return
  sendBatch(buffer.splice(0, buffer.length), id, sec)
}

function sendBatch(batch: SinkEvent[], id: Identity, sec: string): void {
  const body = JSON.stringify({
    licenseKeyHash: id.licenseKeyHash,
    machineIdHash: id.machineIdHash,
    deviceUserId: id.deviceUserId,
    plan_type: id.plan_type,
    appVersion: InstallationVersion,
    batch,
  })
  const post: Promise<void> = postBatch(body, sec, batch.length).finally(() => inFlight.delete(post))
  inFlight.add(post)
}

async function postBatch(body: string, sec: string, count: number): Promise<void> {
  try {
    const res = await fetchImpl(url(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-finny-telemetry-secret": sec,
      },
      body,
    })
    if (!res.ok) {
      log.warn("telemetry ingest rejected", { status: res.status, count })
    }
  } catch (err) {
    log.warn("telemetry ingest failed (fire-and-forget)", {
      error: err instanceof Error ? err.message : String(err),
      count,
    })
  }
}

export namespace TelemetrySink {
  export function enqueue(event: SinkEvent) {
    if (!Telemetry.enabled()) return
    if (buffer.length >= MAX_BUFFER) buffer.shift()
    buffer.push(event)
    if (buffer.length >= MAX_BATCH) void flush()
    else scheduleFlush()
  }

  export async function flush(): Promise<void> {
    // Coalesce concurrent callers (debounce timer + drain) onto a single
    // in-progress flush. Without this, two callers could both pass the
    // empty-buffer guard, both await identity(), and the second would splice an
    // empty buffer and POST an empty batch.
    if (flushInProgress) return flushInProgress
    if (buffer.length === 0) return
    flushInProgress = doFlush().finally(() => {
      flushInProgress = undefined
    })
    return flushInProgress
  }

  export async function drain(timeoutMs = 1500): Promise<void> {
    // flush() only awaits local work (identity); the network POST lives in
    // `inFlight`, so this race actually bounds a slow/hung request.
    await flush().catch(() => {})
    if (inFlight.size === 0) return
    await Promise.race([
      Promise.allSettled(Array.from(inFlight)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  export function _setFetchForTests(next: typeof fetch) {
    fetchImpl = next
  }

  export function resetIdentity() {
    identityPromise = undefined
  }

  export function _resetForTests() {
    fetchImpl = globalThis.fetch.bind(globalThis)
    buffer.length = 0
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    flushInProgress = undefined
    inFlight.clear()
    identityPromise = undefined
    warnedIdentityDrop = false
  }
}
