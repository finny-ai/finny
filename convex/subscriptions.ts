import { mutation } from "./_generated/server"
import { ConvexError, v } from "convex/values"

// RFC 5322 is wildly permissive; this is the same conservative regex used in
// the TUI dialog. Server-side check is required because the public Convex
// client lets callers bypass the TUI and post arbitrary strings.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LEN = 254 // RFC 3696

export const subscribe = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
    version: v.optional(v.string()),
    platform: v.optional(v.string()),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase()
    if (email.length === 0 || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
      throw new ConvexError({ code: "INVALID_EMAIL", message: "email is not a valid address" })
    }
    const now = Date.now()
    const existing = await ctx.db
      .query("emailSubscriptions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first()
    if (existing) {
      await ctx.db.patch(existing._id, {
        source: args.source ?? existing.source,
        version: args.version ?? existing.version,
        platform: args.platform ?? existing.platform,
        deviceId: args.deviceId ?? existing.deviceId,
        time_updated: now,
      })
      return { ok: true, deduped: true }
    }
    await ctx.db.insert("emailSubscriptions", {
      email,
      source: args.source,
      version: args.version,
      platform: args.platform,
      deviceId: args.deviceId,
      time_created: now,
      time_updated: now,
    })
    return { ok: true, deduped: false }
  },
})
