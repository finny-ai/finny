import { convexClient } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"

export namespace ConvexAlgorithms {
  export async function upsert(values: {
    algorithmId: string
    userId: string
    name: string
    code: string
    language: string
    version: number
    status: string
    description?: string
    config?: string
    backtestCode?: string
    localPath?: string
    time_created: number
    time_updated: number
  }) {
    return convexClient().mutation(api.algoclashAlgorithms.upsert, values)
  }

  export async function getById(algorithmId: string) {
    return convexClient().query(api.algoclashAlgorithms.getById, { algorithmId })
  }

  export async function getByName(userId: string, name: string) {
    return convexClient().query(api.algoclashAlgorithms.getByName, { userId, name })
  }

  export async function listByUser(userId: string) {
    return convexClient().query(api.algoclashAlgorithms.listByUser, { userId })
  }

  export async function updateStatus(algorithmId: string, status: string) {
    return convexClient().mutation(api.algoclashAlgorithms.updateStatus, { algorithmId, status })
  }

  export async function remove(algorithmId: string) {
    return convexClient().mutation(api.algoclashAlgorithms.remove, { algorithmId })
  }
}
