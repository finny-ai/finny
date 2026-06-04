import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("projects")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
  },
})

export const list = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("projects").collect()
  },
})

export const upsert = mutation({
  args: {
    id: v.string(),
    worktree: v.string(),
    vcs: v.optional(v.string()),
    name: v.optional(v.string()),
    icon_url: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    time_created: v.number(),
    time_updated: v.number(),
    time_initialized: v.optional(v.number()),
    sandboxes: v.array(v.string()),
    commands: v.optional(v.object({ start: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (existing) {
      await ctx.db.patch(existing._id, {
        worktree: args.worktree,
        vcs: args.vcs,
        name: args.name,
        icon_url: args.icon_url,
        icon_color: args.icon_color,
        time_updated: args.time_updated,
        time_initialized: args.time_initialized,
        sandboxes: args.sandboxes,
        commands: args.commands,
      })
      return { ...existing, ...args }
    }
    await ctx.db.insert("projects", args)
    return args
  },
})

export const update = mutation({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    icon_url: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    commands: v.optional(v.object({ start: v.optional(v.string()) })),
    time_updated: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (!existing) return null
    const { id, ...updates } = args
    await ctx.db.patch(existing._id, updates)
    return { ...existing, ...updates }
  },
})

export const setInitialized = mutation({
  args: { id: v.string(), time_initialized: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (!existing) return
    await ctx.db.patch(existing._id, { time_initialized: args.time_initialized })
  },
})

export const updateSandboxes = mutation({
  args: { id: v.string(), sandboxes: v.array(v.string()), time_updated: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (!existing) return null
    await ctx.db.patch(existing._id, { sandboxes: args.sandboxes, time_updated: args.time_updated })
    return { ...existing, sandboxes: args.sandboxes, time_updated: args.time_updated }
  },
})

export const migrateFromGlobal = mutation({
  args: { newProjectId: v.string(), worktree: v.string() },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_project_id", (q) => q.eq("project_id", "global"))
      .collect()
    for (const session of sessions) {
      if (session.directory && session.directory !== args.worktree) continue
      await ctx.db.patch(session._id, { project_id: args.newProjectId })
    }
    return sessions.length
  },
})
