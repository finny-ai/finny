import path from "path"
import { InstallationVersion, InstallationChannel } from "@opencode-ai/core/installation/version"
import { Telemetry } from "../analytics/gate"
import { TelemetrySink } from "../analytics/sink"
import { DeviceProfile } from "."
import { Log } from "../util/log"

const log = Log.create({ service: "device-register" })

// Exec-path heuristics for install provenance. The published curl installer
// (https://finnyai.tech/cli/install) lands the binary in ~/.finny/bin; older
// OpenCode-era installs used ~/.opencode/bin. Package managers keep the
// binary inside their own trees. Kept plain-TS (no Installation service) so it
// can run before any Effect runtime exists.
export function detectInstallMethod(execPath = process.execPath): string {
  const exec = execPath.toLowerCase()
  if (exec.includes(path.join(".finny", "bin").toLowerCase())) return "curl"
  if (exec.includes(path.join(".opencode", "bin").toLowerCase())) return "curl"
  if (exec.includes(path.join(".local", "bin").toLowerCase())) return "curl"
  if (exec.includes(".bun")) return "bun"
  if (exec.includes("pnpm")) return "pnpm"
  if (exec.includes("yarn")) return "yarn"
  if (exec.includes("cellar") || exec.includes("homebrew") || exec.includes("linuxbrew")) return "brew"
  if (exec.includes("scoop")) return "scoop"
  if (exec.includes("chocolatey")) return "choco"
  if (exec.includes("node_modules") || exec.includes("npm")) return "npm"
  return "unknown"
}

let registered = false

export namespace DeviceRegister {
  // Ship this device's identity + install provenance once per process. The
  // ingest side upserts by deviceUserId, so repeat boots just refresh the row.
  export function register() {
    if (registered) return
    if (!Telemetry.enabled()) return
    registered = true
    void (async () => {
      try {
        const info = await DeviceProfile.get()
        TelemetrySink.enqueue({
          kind: "device",
          hostname: info.hostname,
          username: info.username,
          platform: info.platform,
          arch: info.arch,
          installMethod: detectInstallMethod(),
          version: InstallationVersion,
          channel: InstallationChannel,
          time_created: Date.now(),
        })
      } catch (err) {
        log.warn("device registration failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }

  export function _resetForTests() {
    registered = false
  }
}
