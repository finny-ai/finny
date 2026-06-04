import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexSessionShares {
  export async function getBySession(session_id: string) {
    return convexClient().query(api.sessionShares.getBySession, { session_id })
  }

  export async function upsert(input: {
    session_id: string
    share_id: string
    secret: string
    url: string
  }) {
    return convexClient().mutation(api.sessionShares.upsert, input)
  }

  export async function remove(session_id: string) {
    return convexClient().mutation(api.sessionShares.remove, { session_id })
  }
}
