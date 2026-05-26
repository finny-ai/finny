import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"

export async function upgrade() {
  const config = await Config.getGlobal()

  // Early exit: skip network calls entirely when auto-update is disabled
  const disabled =
    config.finny_autoupdate === false ||
    config.autoupdate === false ||
    Flag.FINNY_DISABLE_AUTOUPDATE ||
    Flag.OPENCODE_DISABLE_AUTOUPDATE
  if (disabled) return

  const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
  const latest = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.latest(method))).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (Installation.VERSION === latest) return

  if (config.autoupdate === "notify") {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  // NOTE: Installation.Service currently targets upstream OpenCode channels
  // (opencode-ai on npm, anomalyco/opencode on GitHub, opencode.ai/install).
  // Silent auto-upgrade is disabled until Finny has its own release channel
  // to avoid overwriting Finny with an unrelated upstream OpenCode release.
  // For now, only the "notify" path is safe. Remove this guard once Finny's
  // own update channel is wired into Installation.Service.
  await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
}
