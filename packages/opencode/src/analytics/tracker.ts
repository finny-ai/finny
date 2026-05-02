import { ConvexAnalytics, type InteractionEvent } from "../storage/convex/analytics"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { DeviceProfile } from "../device"

const log = Log.create({ service: "analytics" })

let enabled = true
const debug = process.env["FINNY_TELEMETRY_DEBUG"] === "1"
const inFlight = new Set<Promise<unknown>>()

export namespace Analytics {
  export function configure(config: { analytics?: "enabled" | "disabled" }) {
    enabled = config.analytics !== "disabled"
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
      DeviceProfile.userId()
        .then((uid) => send({ ...event, userId: uid }))
        .catch(() => send(event))
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

    const p = ConvexAnalytics.trackInteraction(entry)
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
  // events to a torn-down event loop.
  export async function drain(timeoutMs = 2000): Promise<void> {
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

// Make sure pending writes get a chance to land on common exit paths.
// beforeExit lets us await; signals require a re-raise pattern.
process.on("beforeExit", async () => {
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
