import { Log } from "../util/log"
import { DeviceRegister } from "../device/register"
import { Telemetry } from "./gate"
import { SessionSync } from "./session-sync"
import { TelemetrySink } from "./sink"
import { UsageTracker } from "./usage"

const log = Log.create({ service: "telemetry" })

export namespace TelemetryLifecycle {
  // refreshAndStart may run more than once per realm (bootstrap + a re-run at
  // TUI ready), so skip repeating an identical status line. Only the
  // worker/server path logs - the main-process refreshForEmit() stays silent so
  // the two realms (which share one terminal) don't double-log the same message.
  let lastStatus: string | undefined
  function logStatus(enabled: boolean) {
    const hasSecret = !!process.env["FINNY_TELEMETRY_SECRET"]?.trim()
    const key = !enabled ? "disabled:" + Telemetry.statusReason() : hasSecret ? "enabled" : "no-secret"
    if (key === lastStatus) return
    lastStatus = key
    if (!enabled) log.info("telemetry disabled", { reason: Telemetry.statusReason() })
    else if (!hasSecret)
      log.warn("telemetry enabled but FINNY_TELEMETRY_SECRET is unset - batches will be dropped at flush")
  }

  // For the server/worker/daemon: enables the gate AND starts the SessionSync
  // subscriber that turns chat session/message/part events into telemetry,
  // plus device registration (install provenance) and the usage heartbeat.
  // Idempotent and safe to re-run.
  export async function refreshAndStart(surface = "app"): Promise<boolean> {
    TelemetrySink.resetIdentity()
    const enabled = await Telemetry.refresh()
    if (enabled) {
      SessionSync.start()
      DeviceRegister.register()
      UsageTracker.start(surface)
    }
    logStatus(enabled)
    return enabled
  }

  // For processes that emit telemetry directly but do NOT host the session
  // event bus - the TUI main process runs BacktestRunner.run() in-process (see
  // routes/algorithms.tsx), so emit() needs the gate/identity resolved here.
  // SessionSync is deliberately NOT started: chat telemetry is owned by the
  // worker, and a subscriber here would be dead (the main GlobalBus never
  // receives the worker's forwarded events) or risk duplicate rows. Does not log
  // (the worker realm owns status logging) to avoid duplicate startup lines.
  export async function refreshForEmit(): Promise<boolean> {
    TelemetrySink.resetIdentity()
    return Telemetry.refresh()
  }
}
