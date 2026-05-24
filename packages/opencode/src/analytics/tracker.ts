import { ConvexAnalytics, type InteractionEvent } from "../storage/convex/analytics"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { DeviceProfile } from "../device"

const log = Log.create({ service: "analytics" })

// Telemetry is opt-IN in this build. Set FINNY_TELEMETRY=1 (or
// OPENCODE_TELEMETRY=1) to enable; absence keeps it off, and configure()
// cannot re-enable without the env var.
function envEnabled() {
  return process.env["FINNY_TELEMETRY"] === "1" || process.env["OPENCODE_TELEMETRY"] === "1"
}
let enabled = envEnabled()
const debug = process.env["FINNY_TELEMETRY_DEBUG"] === "1"
const inFlight = new Set<Promise<unknown>>()
let drainScheduled = false

export namespace Analytics {
  export function configure(config: { analytics?: "enabled" | "disabled" }) {
    // Explicit disable wins; explicit enable still requires env opt-in so the
    // env var remains the authoritative switch.
    if (config.analytics === "disabled") enabled = false
    else if (envEnabled()) enabled = true
  }

  export function isEnabled() {
    return enabled
  }

  export function track(event: {
    eventType: string
    eventName: string
    sessionId?: string
    projectId?: string
    userId?: string
    metadata?: Record<string, any>
    source?: string
  }) {
    if (!enabled) return

    // Always wrap in a single tracked promise that includes BOTH the userId
    // lookup (if any) and the convex round-trip. drain() races on this outer
    // promise, so it won't return until the actual mutation has settled.
    const p: Promise<void> = (async () => {
      try {
        const userId = event.userId ?? (await DeviceProfile.userId().catch(() => undefined))
        await send({ ...event, userId })
      } catch (err) {
        log.warn("failed to track event", { error: err, eventName: event.eventName })
      }
    })().finally(() => {
      inFlight.delete(p)
    })
    inFlight.add(p)
  }

  function send(event: {
    eventType: string
    eventName: string
    sessionId?: string
    projectId?: string
    userId?: string
    metadata?: Record<string, any>
    source?: string
  }): Promise<void> {
    const entry: InteractionEvent = {
      ...event,
      timestamp: Date.now(),
      version: Installation.VERSION,
    }
    if (debug) log.info("tracking", { eventName: entry.eventName })
    return ConvexAnalytics.trackInteraction(entry)
      .then(() => {
        if (debug) log.info("track ok", { eventName: entry.eventName })
      })
      .catch((err) => {
        log.warn("failed to track event", { error: err, eventName: entry.eventName })
      })
  }

  // Wait for any pending writes — useful before process exit so we don't lose
  // events to a torn-down event loop. Returns when either all in-flight work
  // settles or the timeout elapses, whichever comes first.
  export async function drain(timeoutMs = 1500): Promise<void> {
    if (inFlight.size === 0) return
    await Promise.race([
      Promise.allSettled(Array.from(inFlight)),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ])
  }

  // Back-compat: old callers (bootstrap.ts) call flush() — keep it as an alias
  // for drain() so nothing breaks. Synchronous: returns void, drain in bg.
  export function flush() {
    void drain()
  }
}

// Best-effort flush on common exit paths. We deliberately drain only ONCE
// from `beforeExit` — otherwise a hung telemetry request that resolves later
// would keep re-arming the timer and stall shutdown indefinitely.
process.on("beforeExit", async () => {
  if (drainScheduled) return
  drainScheduled = true
  await Analytics.drain(1500).catch(() => {})
})

const signalHandler = (sig: NodeJS.Signals) => {
  process.removeListener(sig, signalHandler as any)
  Analytics.drain(1500)
    .catch(() => {})
    .finally(() => process.kill(process.pid, sig))
}
process.on("SIGINT", signalHandler)
process.on("SIGTERM", signalHandler)
