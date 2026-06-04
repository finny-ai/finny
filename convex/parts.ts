import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const upsert = mutation({
  args: {
    id: v.string(),
    message_id: v.string(),
    session_id: v.string(),
    time_created: v.number(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("parts")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (existing) {
      await ctx.db.patch(existing._id, { data: args.data, time_updated: Date.now() })
      return { ...existing, data: args.data }
    }
    await ctx.db.insert("parts", { ...args, time_updated: Date.now() })
    return args
  },
})

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const part = await ctx.db
      .query("parts")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (part) {
      await ctx.db.delete(part._id)
    }
  },
})

export const listByMessage = query({
  args: { message_id: v.string() },
  handler: async (ctx, args) => {
    const parts = await ctx.db
      .query("parts")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .collect()
    return parts.sort((a, b) => a.id.localeCompare(b.id))
  },
})

export const listByMessages = query({
  args: { message_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const results: Record<string, any[]> = {}
    for (const messageId of args.message_ids) {
      const parts = await ctx.db
        .query("parts")
        .withIndex("by_message_id", (q) => q.eq("message_id", messageId))
        .collect()
      results[messageId] = parts.sort((a, b) => a.id.localeCompare(b.id))
    }
    return results
  },
})

export const insertBatch = mutation({
  args: {
    parts: v.array(
      v.object({
        id: v.string(),
        message_id: v.string(),
        session_id: v.string(),
        time_created: v.number(),
        data: v.any(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const part of args.parts) {
      const existing = await ctx.db
        .query("parts")
        .withIndex("by_ext_id", (q) => q.eq("id", part.id))
        .first()
      if (!existing) {
        await ctx.db.insert("parts", { ...part, time_updated: Date.now() })
      }
    }
  },
})
