import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const trackInteraction = mutation({
  args: {
    userId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    eventType: v.string(),
    eventName: v.string(),
    metadata: v.optional(v.any()),
    timestamp: v.number(),
    source: v.optional(v.string()),
    version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("interactions", args)
  },
})

export const trackBatch = mutation({
  args: {
    events: v.array(
      v.object({
        userId: v.optional(v.string()),
        sessionId: v.optional(v.string()),
        projectId: v.optional(v.string()),
        eventType: v.string(),
        eventName: v.string(),
        metadata: v.optional(v.any()),
        timestamp: v.number(),
        source: v.optional(v.string()),
        version: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const event of args.events) {
      await ctx.db.insert("interactions", event)
    }
  },
})

export const getInteractions = query({
  args: {
    sessionId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.sessionId) {
      const results = await ctx.db
        .query("interactions")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .collect()
      return results.slice(0, args.limit ?? 100)
    }
    if (args.projectId) {
      const results = await ctx.db
        .query("interactions")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect()
      return results.slice(0, args.limit ?? 100)
    }
    const results = await ctx.db
      .query("interactions")
      .withIndex("by_timestamp")
      .order("desc")
      .collect()
    return results.slice(0, args.limit ?? 100)
  },
})
