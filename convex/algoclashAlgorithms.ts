import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const upsert = mutation({
  args: {
    algorithmId: v.string(),
    userId: v.string(),
    name: v.string(),
    code: v.string(),
    language: v.string(),
    version: v.number(),
    status: v.string(),
    description: v.optional(v.string()),
    config: v.optional(v.string()),
    backtestCode: v.optional(v.string()),
    localPath: v.optional(v.string()),
    time_created: v.number(),
    time_updated: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .first()
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        code: args.code,
        language: args.language,
        version: args.version,
        status: args.status,
        description: args.description,
        config: args.config,
        backtestCode: args.backtestCode,
        localPath: args.localPath,
        time_updated: args.time_updated,
      })
      return { ...existing, ...args }
    }
    await ctx.db.insert("algoclashAlgorithms", args)
    return args
  },
})

export const getById = query({
  args: { algorithmId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .first()
  },
})

export const getByName = query({
  args: { userId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_userId_name", (q) => q.eq("userId", args.userId).eq("name", args.name))
      .first()
  },
})

export const listByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect()
    return results.sort((a, b) => b.time_updated - a.time_updated)
  },
})

export const updateStatus = mutation({
  args: { algorithmId: v.string(), status: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .first()
    if (!existing) return null
    await ctx.db.patch(existing._id, {
      status: args.status,
      time_updated: Date.now(),
    })
    return { ...existing, status: args.status }
  },
})

export const remove = mutation({
  args: { algorithmId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .first()
    if (!existing) return null
    await ctx.db.delete(existing._id)
    return existing
  },
})
