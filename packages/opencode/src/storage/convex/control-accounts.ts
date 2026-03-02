import { convexClient } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"

export namespace ConvexControlAccounts {
  export async function getActive() {
    return convexClient().query(api.controlAccounts.getActive, {})
  }

  export async function updateTokens(input: {
    email: string
    url: string
    access_token: string
    refresh_token?: string
    token_expiry?: number
  }) {
    return convexClient().mutation(api.controlAccounts.updateTokens, input)
  }

  export async function upsert(input: {
    email: string
    url: string
    access_token: string
    refresh_token: string
    token_expiry?: number
    active: boolean
  }) {
    return convexClient().mutation(api.controlAccounts.upsert, input)
  }
}
