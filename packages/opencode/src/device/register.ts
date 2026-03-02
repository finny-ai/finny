import { DeviceProfile } from "."
import { Installation } from "../installation"
import { ConvexDevices } from "../storage/convex/devices"
import { Log } from "../util/log"

const log = Log.create({ service: "device" })

export function registerDevice() {
  // Fire-and-forget — never block CLI startup
  void (async () => {
    try {
      const profile = await DeviceProfile.get()
      const now = Date.now()
      let installMethod: string | undefined
      try {
        installMethod = await Installation.method()
      } catch {
        // Installation.method() can fail — not critical
      }
      await ConvexDevices.upsert({
        userId: profile.userId,
        hostname: profile.hostname,
        username: profile.username,
        platform: profile.platform,
        arch: profile.arch,
        installMethod,
        version: Installation.VERSION,
        channel: Installation.CHANNEL,
        time_created: now,
        time_updated: now,
      })
      log.info("device registered", { userId: profile.userId })
    } catch (e) {
      log.warn("device registration failed", { error: e })
    }
  })()
}
