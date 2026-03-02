import { convexClient } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"

export namespace ConvexMessages {
  export async function upsert(values: {
    id: string
    session_id: string
    time_created: number
    data: any
  }) {
    return convexClient().mutation(api.messages.upsert, values)
  }

  export async function remove(id: string) {
    return convexClient().mutation(api.messages.remove, { id })
  }

  export async function getById(id: string) {
    return convexClient().query(api.messages.getById, { id })
  }

  export async function stream(session_id: string, limit: number, offset: number) {
    return convexClient().query(api.messages.stream, {
      session_id,
      limit,
      offset,
    })
  }

  export async function listBySession(session_id: string) {
    return convexClient().query(api.messages.listBySession, { session_id })
  }

  export async function insertBatch(
    messages: Array<{
      id: string
      session_id: string
      time_created: number
      data: any
    }>,
  ) {
    return convexClient().mutation(api.messages.insertBatch, { messages })
  }
}
