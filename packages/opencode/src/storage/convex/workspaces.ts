import { convexClient } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"

export namespace ConvexWorkspaces {
  export async function create(input: {
    id: string
    branch?: string
    project_id: string
    config: any
  }) {
    return convexClient().mutation(api.workspaces.create, input)
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
