import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { Analytics } from "../analytics/tracker"

// Telemetry is opt-in by default; users can disable with FINNY_TELEMETRY=0.
Analytics.configure({
  analytics:
    process.env["FINNY_TELEMETRY"] === "0" || process.env["OPENCODE_TELEMETRY"] === "0" ? "disabled" : "enabled",
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
