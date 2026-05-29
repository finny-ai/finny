import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { Analytics } from "../analytics/tracker"

function telemetryEnabled() {
  const finny = process.env["FINNY_TELEMETRY"]?.toLowerCase()
  const opencode = process.env["OPENCODE_TELEMETRY"]?.toLowerCase()
  return finny === "1" || finny === "true" || opencode === "1" || opencode === "true"
}

// Telemetry is disabled by default; users can opt in with FINNY_TELEMETRY=1
// (or OPENCODE_TELEMETRY=1). FINNY_TELEMETRY=0 remains a hard kill switch.
Analytics.configure({
  analytics: telemetryEnabled() ? "enabled" : "disabled",
})

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  return Instance.provide({
    directory,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        const result = await cb()
        return result
      } finally {
        try {
          Analytics.flush()
        } catch {}
        await Instance.dispose()
      }
    },
  })
}
