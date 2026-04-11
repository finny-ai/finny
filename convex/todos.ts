import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const replaceForSession = mutation({
  args: {
    session_id: v.string(),
    todos: v.array(
      v.object({
        content: v.string(),
        status: v.string(),
        priority: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    // Delete existing todos for session
    const existing = await ctx.db
      .query("todos")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .collect()
    for (const todo of existing) {
      await ctx.db.delete(todo._id)
    }

    // Insert new todos
    const now = Date.now()
    for (let position = 0; position < args.todos.length; position++) {
      const todo = args.todos[position]
      await ctx.db.insert("todos", {
        session_id: args.session_id,
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
        position,
        time_created: now,
        time_updated: now,
      })
    }
  },
})

export const getBySession = query({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const todos = await ctx.db
      .query("todos")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .collect()
    return todos.sort((a, b) => a.position - b.position)
  },
})
