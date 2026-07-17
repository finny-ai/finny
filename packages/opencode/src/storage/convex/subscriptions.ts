import { convexClientOrDefault } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"

export namespace ConvexSubscriptions {
  export async function subscribe(input: {
    email: string
    source?: string
    version?: string
    platform?: string
    deviceId?: string
  }) {
    // Email capture uses the production-defaulted client so shipped builds
    // (with no CONVEX_URL) still land subscriptions in wry-mastiff-821.
    return convexClientOrDefault().mutation(api.subscriptions.subscribe, input)
  }
}
