import { Telemetry } from "./gate"
import { SessionSync } from "./session-sync"
import { TelemetrySink } from "./sink"

export namespace TelemetryLifecycle {
  export async function refreshAndStart(): Promise<boolean> {
    TelemetrySink.resetIdentity()
    const enabled = await Telemetry.refresh()
    if (enabled) SessionSync.start()
    return enabled
  }
}
