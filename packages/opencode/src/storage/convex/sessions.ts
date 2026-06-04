import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexSessions {
  export async function getById(id: string) {
    return convexClient().query(api.sessions.getById, { id })
  }

  export async function create(values: {
    id: string
    project_id: string
    workspace_id?: string
    parent_id?: string
    user_id?: string
    slug: string
    directory: string
    title: string
    version: string
    share_url?: string
    summary_additions?: number
    summary_deletions?: number
    summary_files?: number
    summary_diffs?: any
    revert?: any
    permission?: any
    time_created: number
    time_updated: number
    time_compacting?: number
    time_archived?: number
  }) {
    return convexClient().mutation(api.sessions.create, values)
  }

  export async function update(id: string, updates: Record<string, any>) {
    return convexClient().mutation(api.sessions.update, { id, updates })
  }

  export async function touch(id: string) {
    return convexClient().mutation(api.sessions.touch, {
      id,
      time_updated: Date.now(),
    })
  }

  export async function remove(id: string) {
    return convexClient().mutation(api.sessions.remove, { id })
  }

  export async function listByProject(input: {
    project_id: string
    directory?: string
    roots?: boolean
    start?: number
    search?: string
    limit?: number
  }) {
    return convexClient().query(api.sessions.listByProject, input)
  }

  export async function listGlobal(input?: {
    directory?: string
    roots?: boolean
    start?: number
    cursor?: number
    search?: string
    limit?: number
    archived?: boolean
  }) {
    return convexClient().query(api.sessions.listGlobal, input ?? {})
  }

  export async function listChildren(project_id: string, parent_id: string) {
    return convexClient().query(api.sessions.listChildren, {
      project_id,
      parent_id,
    })
  }

  export async function listAll() {
    return convexClient().query(api.sessions.listAll, {})
  }
}
