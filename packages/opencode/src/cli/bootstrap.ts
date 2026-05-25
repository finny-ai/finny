import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../project/instance"
import { Analytics } from "../analytics/tracker"

// Telemetry is opt-in; users can enable it with FINNY_TELEMETRY=1
// (or OPENCODE_TELEMETRY=1). The env opt-in is also enforced inside the
// tracker module itself so non-bootstrap entrypoints (TUI worker, etc.)
// honor it without needing this call.
Analytics.configure({
  analytics:
    process.env["FINNY_TELEMETRY"] === "1" || process.env["OPENCODE_TELEMETRY"] === "1" ? "enabled" : "disabled",
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
