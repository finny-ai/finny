import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const create = mutation({
  args: {
    id: v.string(),
    branch: v.optional(v.string()),
    project_id: v.string(),
    config: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("workspaces", args)
    return args
  },
})

export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("workspaces")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
  },
})

export const listByProject = query({
  args: { project_id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("workspaces")
      .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id))
      .collect()
  },
})

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (workspace) {
      await ctx.db.delete(workspace._id)
    }
  },
})
