import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexProjects {
  export async function getById(id: string) {
    return convexClient().query(api.projects.getById, { id })
  }

  export async function list() {
    return convexClient().query(api.projects.list, {})
  }

  export async function upsert(values: {
    id: string
    worktree: string
    vcs?: string
    name?: string
    icon_url?: string
    icon_color?: string
    time_created: number
    time_updated: number
    time_initialized?: number
    sandboxes: string[]
    commands?: { start?: string }
  }) {
    return convexClient().mutation(api.projects.upsert, values)
  }

  export async function update(input: {
    id: string
    name?: string
    icon_url?: string
    icon_color?: string
    commands?: { start?: string }
    time_updated: number
  }) {
    return convexClient().mutation(api.projects.update, input)
  }

  export async function setInitialized(id: string) {
    return convexClient().mutation(api.projects.setInitialized, {
      id,
      time_initialized: Date.now(),
    })
  }

  export async function updateSandboxes(id: string, sandboxes: string[]) {
    return convexClient().mutation(api.projects.updateSandboxes, {
      id,
      sandboxes,
      time_updated: Date.now(),
    })
  }

  export async function migrateFromGlobal(newProjectId: string, worktree: string) {
    return convexClient().mutation(api.projects.migrateFromGlobal, {
      newProjectId,
      worktree,
    })
  }
}
