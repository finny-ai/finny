import { convexClient } from "../convex-client"
import { api as generatedApi } from "../../../../../convex/_generated/api"
const api = generatedApi as any

export namespace ConvexTodos {
  export async function replaceForSession(
    session_id: string,
    todos: Array<{ content: string; status: string; priority: string }>,
  ) {
    return convexClient().mutation(api.todos.replaceForSession, {
      session_id,
      todos,
    })
  }

  export async function getBySession(session_id: string) {
    return convexClient().query(api.todos.getBySession, { session_id })
  }
}
