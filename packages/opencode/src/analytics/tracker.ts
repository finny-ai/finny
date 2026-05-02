import { ConvexAnalytics, type InteractionEvent } from "../storage/convex/analytics"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { DeviceProfile } from "../device"

const log = Log.create({ service: "analytics" })

// Read opt-out at module load so every importer (TUI worker, server, CLI)
// honors FINNY_TELEMETRY=0 without needing to call configure() first.
function envDisabled() {
  return process.env["FINNY_TELEMETRY"] === "0" || process.env["OPENCODE_TELEMETRY"] === "0"
}
let enabled = !envDisabled()
const debug = process.env["FINNY_TELEMETRY_DEBUG"] === "1"
const inFlight = new Set<Promise<unknown>>()
let drainScheduled = false

export namespace Analytics {
  export function configure(config: { analytics?: "enabled" | "disabled" }) {
    // Explicit disable wins; explicit enable still respects env opt-out so the
    // env var remains a hard kill switch.
    if (config.analytics === "disabled") enabled = false
    else if (!envDisabled()) enabled = true
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

    if (!event.userId) {
      // Track the userId-resolution promise too so drain() can wait on it.
      // Without this an event still mid-resolution at shutdown would be dropped.
      const p: Promise<void> = DeviceProfile.userId()
        .then((uid) => send({ ...event, userId: uid }))
        .catch(() => send(event))
        .finally(() => {
          inFlight.delete(p)
        })
      inFlight.add(p)
      return
    }

    send(event)
  }

  function send(event: {
    eventType: string
    eventName: string
    sessionId?: string
    projectId?: string
    userId?: string
    metadata?: Record<string, any>
    source?: string
  }) {
    const entry: InteractionEvent = {
      ...event,
      timestamp: Date.now(),
      version: Installation.VERSION,
    }
    if (debug) log.info("tracking", { eventName: entry.eventName })

    const p: Promise<void> = ConvexAnalytics.trackInteraction(entry)
      .then(() => {
        if (debug) log.info("track ok", { eventName: entry.eventName })
      })
      .catch((err) => {
        log.warn("failed to track event", { error: err, eventName: entry.eventName })
      })
      .finally(() => {
        inFlight.delete(p)
      })
    inFlight.add(p)
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
