import { convexClient } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"
import type { BrokerKind } from "@/live/brokers"

export namespace ConvexAlgorithms {
  // `version` is intentionally NOT in the args — Convex assigns it atomically
  // server-side (max(existing for algorithmId) + 1) so concurrent saves from
  // multiple devices can't collide.
  export async function insertVersion(values: {
    algorithmId: string
    userId: string
    name: string
    code: string
    language: string
    status: string
    description?: string
    config?: string
    backtestCode?: string
    localPath?: string
    brokerKind?: BrokerKind
    time_created: number
    time_updated: number
  }) {
    return convexClient().mutation(api.algoclashAlgorithms.insertVersion, values)
  }

  export async function patchLatestConfig(algorithmId: string, config: string) {
    return convexClient().mutation(api.algoclashAlgorithms.patchLatestConfig, { algorithmId, config })
  }

  export async function getById(algorithmId: string) {
    return convexClient().query(api.algoclashAlgorithms.getById, { algorithmId })
  }

  export async function getByIdAndVersion(algorithmId: string, version: number) {
    return convexClient().query(api.algoclashAlgorithms.getByIdAndVersion, { algorithmId, version })
  }

  export async function getByName(userId: string, name: string) {
    return convexClient().query(api.algoclashAlgorithms.getByName, { userId, name })
  }

  export async function listByUser(userId: string) {
    return convexClient().query(api.algoclashAlgorithms.listByUser, { userId })
  }

  export async function listVersions(algorithmId: string) {
    return convexClient().query(api.algoclashAlgorithms.listVersions, { algorithmId })
  }

  export async function updateStatus(algorithmId: string, status: string) {
    return convexClient().mutation(api.algoclashAlgorithms.updateStatus, { algorithmId, status })
  }

  export async function remove(algorithmId: string) {
    return convexClient().mutation(api.algoclashAlgorithms.remove, { algorithmId })
  }
}
