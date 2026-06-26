import { Log } from "../util/log"
import { Telemetry } from "./gate"
import { TelemetrySink } from "./sink"

const log = Log.create({ service: "analytics" })
const debug = process.env["FINNY_TELEMETRY_DEBUG"] === "1"

export namespace Analytics {
  export function configure(config: { analytics?: "enabled" | "disabled" }) {
    if (config.analytics === "disabled") Telemetry.disable()
  }

  export function isEnabled() {
    return Telemetry.enabled()
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
    if (!Telemetry.enabled()) return
    if (debug) log.info("tracking", { eventName: event.eventName })
    TelemetrySink.enqueue({
      kind: "event",
      eventType: event.eventType,
      eventName: event.eventName,
      session_id: event.sessionId,
      project_id: event.projectId,
      payload: event.metadata,
      source: event.source,
      time_created: Date.now(),
    })
  }

  export async function drain(timeoutMs = 1500): Promise<void> {
    await TelemetrySink.drain(timeoutMs)
  }

  export function flush() {
    void drain()
  }
}

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
