import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const getActive = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("controlAccounts")
      .withIndex("by_active", (q) => q.eq("active", true))
      .first()
  },
})

export const updateTokens = mutation({
  args: {
    email: v.string(),
    url: v.string(),
    access_token: v.string(),
    refresh_token: v.optional(v.string()),
    token_expiry: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("controlAccounts")
      .withIndex("by_email_url", (q) => q.eq("email", args.email).eq("url", args.url))
      .first()
    if (!existing) return
    await ctx.db.patch(existing._id, {
      access_token: args.access_token,
      refresh_token: args.refresh_token ?? existing.refresh_token,
      token_expiry: args.token_expiry,
      time_updated: Date.now(),
    })
  },
})

export const upsert = mutation({
  args: {
    email: v.string(),
    url: v.string(),
    access_token: v.string(),
    refresh_token: v.string(),
    token_expiry: v.optional(v.number()),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("controlAccounts")
      .withIndex("by_email_url", (q) => q.eq("email", args.email).eq("url", args.url))
      .first()
    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        access_token: args.access_token,
        refresh_token: args.refresh_token,
        token_expiry: args.token_expiry,
        active: args.active,
        time_updated: now,
      })
    } else {
      await ctx.db.insert("controlAccounts", {
        ...args,
        time_created: now,
        time_updated: now,
      })
    }
  },
})
