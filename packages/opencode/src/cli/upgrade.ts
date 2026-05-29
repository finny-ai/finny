import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"

export async function upgrade() {
  const config = await Config.getGlobal()
  const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
  const latest = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.latest(method))).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (Installation.VERSION === latest) return
  if (config.finny_autoupdate === false || Flag.FINNY_DISABLE_AUTOUPDATE) return

  if (config.autoupdate === "notify") {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (method === "unknown") return
  await AppRuntime.runPromise(Installation.Service.use((svc) => svc.upgrade(method, latest)))
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch(() => {})
}
