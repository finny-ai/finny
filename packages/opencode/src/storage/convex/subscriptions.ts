import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexSubscriptions {
  export async function subscribe(input: {
    email: string
    source?: string
    version?: string
    platform?: string
    deviceId?: string
  }) {
    return convexClient().mutation(api.subscriptions.subscribe, input)
  }
}
