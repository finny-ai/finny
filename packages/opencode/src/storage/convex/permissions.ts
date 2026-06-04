import { convexClient } from "../convex-client"
import { api } from "../../../../../convex/_generated/api"

export namespace ConvexPermissions {
  export async function getByProject(project_id: string) {
    return convexClient().query(api.permissions.getByProject, { project_id })
  }

  export async function upsert(project_id: string, data: any) {
    return convexClient().mutation(api.permissions.upsert, {
      project_id,
      data,
    })
  }
}
