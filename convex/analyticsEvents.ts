import { mutation } from "./_generated/server"
import { v } from "convex/values"

export const track = mutation({
  args: {
    userId: v.string(),
    deviceId: v.optional(v.string()),
    eventType: v.string(),
    algorithmId: v.optional(v.string()),
    payload: v.any(),
    timestamp: v.number(),
    source: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("analyticsEvents", args)
  },
})
