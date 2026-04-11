import { ConvexAnalytics, type InteractionEvent } from "../storage/convex/analytics"
import { Log } from "../util/log"
import { Installation } from "../installation"
import { DeviceProfile } from "../device"

const log = Log.create({ service: "analytics" })

let enabled = true
const buffer: InteractionEvent[] = []
let flushTimer: NodeJS.Timeout | undefined
const FLUSH_INTERVAL = 5000
const FLUSH_THRESHOLD = 50

export namespace Analytics {
  export function configure(config: { analytics?: "enabled" | "disabled" }) {
    enabled = config.analytics !== "disabled"
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

    // Auto-populate userId from device profile if not provided
    if (!event.userId) {
      DeviceProfile.userId()
        .then((uid) => {
          bufferEvent({ ...event, userId: uid })
        })
        .catch(() => {
          bufferEvent(event)
        })
      return
    }

    bufferEvent(event)
  }

  function bufferEvent(event: {
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

    buffer.push(entry)

    if (buffer.length >= FLUSH_THRESHOLD) {
      flush()
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_INTERVAL)
    }
  }

  export function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }

    if (buffer.length === 0) return

    const events = buffer.splice(0, buffer.length)

    // Fire and forget — never block the TUI/CLI
    ConvexAnalytics.trackBatch(events).catch((err) => {
      log.warn("failed to flush analytics", { error: err, count: events.length })
    })
  }
}
