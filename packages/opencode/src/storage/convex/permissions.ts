import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

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
