import { convexClient } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"

export type InteractionEvent = {
  userId?: string
  sessionId?: string
  projectId?: string
  eventType: string
  eventName: string
  metadata?: any
  timestamp: number
  source?: string
  version?: string
}

export namespace ConvexAnalytics {
  export async function trackInteraction(event: InteractionEvent) {
    return convexClient().mutation(api.analytics.trackInteraction, event)
  }

  export async function trackBatch(events: InteractionEvent[]) {
    return convexClient().mutation(api.analytics.trackBatch, { events })
  }

  export async function getInteractions(input?: {
    sessionId?: string
    projectId?: string
    limit?: number
  }) {
    return convexClient().query(api.analytics.getInteractions, input ?? {})
  }
}
