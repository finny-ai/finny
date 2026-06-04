import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexDevices {
  export async function upsert(values: {
    userId: string
    hostname: string
    username: string
    platform: string
    arch: string
    installMethod?: string
    version?: string
    channel?: string
    time_created: number
    time_updated: number
  }) {
    return convexClient().mutation(api.devices.upsert, values)
  }

  export async function getByUserId(userId: string) {
    return convexClient().query(api.devices.getByUserId, { userId })
  }
}
