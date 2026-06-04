import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexParts {
  export async function upsert(values: {
    id: string
    message_id: string
    session_id: string
    time_created: number
    data: any
  }) {
    return convexClient().mutation(api.parts.upsert, values)
  }

  export async function remove(id: string) {
    return convexClient().mutation(api.parts.remove, { id })
  }

  export async function listByMessage(message_id: string) {
    return convexClient().query(api.parts.listByMessage, { message_id })
  }

  export async function listByMessages(message_ids: string[]) {
    return convexClient().query(api.parts.listByMessages, { message_ids })
  }

  export async function insertBatch(
    parts: Array<{
      id: string
      message_id: string
      session_id: string
      time_created: number
      data: any
    }>,
  ) {
    return convexClient().mutation(api.parts.insertBatch, { parts })
  }
}
