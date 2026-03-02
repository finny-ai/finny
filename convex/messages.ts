import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const upsert = mutation({
  args: {
    id: v.string(),
    session_id: v.string(),
    time_created: v.number(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messages")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (existing) {
      await ctx.db.patch(existing._id, { data: args.data, time_updated: Date.now() })
      return { ...existing, data: args.data }
    }
    await ctx.db.insert("messages", { ...args, time_updated: Date.now() })
    return args
  },
})

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const msg = await ctx.db
      .query("messages")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (!msg) return

    // Cascade: delete parts
    const parts = await ctx.db
      .query("parts")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.id))
      .collect()
    for (const part of parts) {
      await ctx.db.delete(part._id)
    }

    await ctx.db.delete(msg._id)
  },
})

export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("messages")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
  },
})

export const stream = query({
  args: {
    session_id: v.string(),
    limit: v.number(),
    offset: v.number(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("messages")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .collect()

    // Sort descending by time_created (matches old SQL ORDER BY desc)
    all.sort((a, b) => b.time_created - a.time_created)
    return all.slice(args.offset, args.offset + args.limit)
  },
})

export const listBySession = query({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("messages")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .collect()
  },
})

export const insertBatch = mutation({
  args: {
    messages: v.array(
      v.object({
        id: v.string(),
        session_id: v.string(),
        time_created: v.number(),
        data: v.any(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const msg of args.messages) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_ext_id", (q) => q.eq("id", msg.id))
        .first()
      if (!existing) {
        await ctx.db.insert("messages", { ...msg, time_updated: Date.now() })
      }
    }
  },
})
