import crypto from "crypto"
import { Telemetry } from "./gate"
import { TelemetrySink } from "./sink"
import { detectInstallMethod } from "../device/register"
import { Log } from "../util/log"

const log = Log.create({ service: "usage-tracker" })

const HEARTBEAT_MS = 60_000

let runId: string | undefined
let surfaceName: string | undefined
let installMethod: string | undefined
let startedAt = 0
let timer: ReturnType<typeof setInterval> | undefined

function beat(endedAt?: number) {
  if (!runId) return
  try {
    TelemetrySink.enqueue({
      kind: "usage",
      runId,
      surface: surfaceName,
      platform: process.platform,
      installMethod,
      startedAt,
      lastActiveAt: endedAt ?? Date.now(),
      endedAt,
      time_created: Date.now(),
    })
  } catch (err) {
    log.warn("usage heartbeat failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function onExit() {
  void UsageTracker.stop()
}

export namespace UsageTracker {
  // One usageSessions row per process run: the first heartbeat inserts it, a
  // 60s interval keeps lastActiveAt fresh (kills still count usage up to the
  // last beat), and exit paths stamp endedAt. Rides the normal sink batching,
  // so a beat costs nothing beyond the existing flush cadence.
  export function start(surface: string) {
    if (runId) return
    if (!Telemetry.enabled()) return
    runId = crypto.randomUUID()
    surfaceName = surface
    startedAt = Date.now()
    installMethod = detectInstallMethod()
    beat()
    timer = setInterval(() => beat(), HEARTBEAT_MS)
    if (typeof timer.unref === "function") timer.unref()
    process.once("beforeExit", onExit)
    process.once("SIGINT", onExit)
    process.once("SIGTERM", onExit)
  }

  export async function stop() {
    if (!runId) return
    if (timer) clearInterval(timer)
    timer = undefined
    beat(Date.now())
    runId = undefined
    await TelemetrySink.drain().catch(() => {})
  }

  export function _resetForTests() {
    if (timer) clearInterval(timer)
    timer = undefined
    runId = undefined
    surfaceName = undefined
    installMethod = undefined
    startedAt = 0
    process.removeListener("beforeExit", onExit)
    process.removeListener("SIGINT", onExit)
    process.removeListener("SIGTERM", onExit)
  }
}
