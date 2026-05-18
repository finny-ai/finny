import { convexClient } from "../storage/convex-client"
import { api } from "../../../../convex/_generated/api"
import { DeviceProfile } from "../device"
import { Log } from "../util/log"

const log = Log.create({ service: "analytics-emit" })

export interface EmitInput {
  eventType: string
  payload: Record<string, any>
  algorithmId?: string
  source?: string
}

export function emit(input: EmitInput): void {
  const work = (async () => {
    try {
      const userId = await DeviceProfile.userId()
      const device = await DeviceProfile.get()

      await convexClient().mutation(api.analyticsEvents.track, {
        userId,
        deviceId: `${device.hostname}-${device.username}`,
        eventType: input.eventType,
        algorithmId: input.algorithmId,
        payload: input.payload,
        timestamp: Date.now(),
        source: input.source,
        appVersion: process.env.npm_package_version,
      })
    } catch (e) {
      log.warn("analytics emit failed (fire-and-forget)", {
        eventType: input.eventType,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })()

  work.catch(() => {})
}
