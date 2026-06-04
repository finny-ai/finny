import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const getBySession = query({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sessionShares")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .first()
  },
})

export const upsert = mutation({
  args: {
    session_id: v.string(),
    share_id: v.string(),
    secret: v.string(),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessionShares")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .first()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        share_id: args.share_id,
        secret: args.secret,
        url: args.url,
        time_updated: now,
      })
    } else {
      await ctx.db.insert("sessionShares", {
        ...args,
        time_created: now,
        time_updated: now,
      })
    }
  },
})

export const remove = mutation({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessionShares")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .first()
    if (existing) {
      await ctx.db.delete(existing._id)
    }
  },
})
