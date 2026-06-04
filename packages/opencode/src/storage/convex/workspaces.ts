import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexWorkspaces {
  export async function create(input: {
    id: string
    type: string
    branch?: string | null
    name?: string | null
    directory?: string | null
    extra?: unknown | null
    project_id: string
  }) {
    return convexClient().mutation(api.workspaces.create, {
      id: input.id,
      type: input.type,
      branch: input.branch ?? undefined,
      name: input.name ?? undefined,
      directory: input.directory ?? undefined,
      extra: input.extra ?? undefined,
      project_id: input.project_id,
    })
  }

  export async function getById(id: string) {
    return convexClient().query(api.workspaces.getById, { id })
  }

  export async function listByProject(project_id: string) {
    return convexClient().query(api.workspaces.listByProject, { project_id })
  }

  export async function remove(id: string) {
    return convexClient().mutation(api.workspaces.remove, { id })
  }
}
