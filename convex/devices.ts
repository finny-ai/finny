import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const upsert = mutation({
  args: {
    userId: v.string(),
    hostname: v.string(),
    username: v.string(),
    platform: v.string(),
    arch: v.string(),
    installMethod: v.optional(v.string()),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
    time_created: v.number(),
    time_updated: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first()
    if (existing) {
      await ctx.db.patch(existing._id, {
        hostname: args.hostname,
        username: args.username,
        platform: args.platform,
        arch: args.arch,
        installMethod: args.installMethod,
        version: args.version,
        channel: args.channel,
        time_updated: args.time_updated,
      })
      return { ...existing, ...args }
    }
    await ctx.db.insert("devices", args)
    return args
  },
})

export const getByUserId = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("devices")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first()
  },
})

export const list = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("devices")
      .order("desc")
      .collect()
  },
})
