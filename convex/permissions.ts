import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const getByProject = query({
  args: { project_id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("permissions")
      .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id))
      .first()
  },
})

export const upsert = mutation({
  args: {
    project_id: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("permissions")
      .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id))
      .first()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { data: args.data, time_updated: now })
    } else {
      await ctx.db.insert("permissions", {
        project_id: args.project_id,
        data: args.data,
        time_created: now,
        time_updated: now,
      })
    }
  },
})
