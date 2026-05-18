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
    if (!args.userId || typeof args.userId !== "string" || args.userId.length > 128) {
      return
    }
    if (!args.eventType || typeof args.eventType !== "string") {
      return
    }
    await ctx.db.insert("analyticsEvents", {
      ...args,
      timestamp: Date.now(),
    })
  },
})
