import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const getById = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sessions")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
  },
})

export const create = mutation({
  args: {
    id: v.string(),
    project_id: v.string(),
    workspace_id: v.optional(v.string()),
    parent_id: v.optional(v.string()),
    user_id: v.optional(v.string()),
    slug: v.string(),
    directory: v.string(),
    title: v.string(),
    version: v.string(),
    share_url: v.optional(v.string()),
    summary_additions: v.optional(v.number()),
    summary_deletions: v.optional(v.number()),
    summary_files: v.optional(v.number()),
    summary_diffs: v.optional(v.any()),
    revert: v.optional(v.any()),
    permission: v.optional(v.any()),
    time_created: v.number(),
    time_updated: v.number(),
    time_compacting: v.optional(v.number()),
    time_archived: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("sessions", args)
    return args
  },
})

export const update = mutation({
  args: {
    id: v.string(),
    updates: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (!existing) return null
    await ctx.db.patch(existing._id, args.updates)
    return { ...existing, ...args.updates }
  },
})

export const touch = mutation({
  args: { id: v.string(), time_updated: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (!existing) return null
    await ctx.db.patch(existing._id, { time_updated: args.time_updated })
    return { ...existing, time_updated: args.time_updated }
  },
})

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_ext_id", (q) => q.eq("id", args.id))
      .first()
    if (!session) return

    // Cascade: delete all messages and parts
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.id))
      .collect()
    for (const msg of messages) {
      const parts = await ctx.db
        .query("parts")
        .withIndex("by_message_id", (q) => q.eq("message_id", msg.id))
        .collect()
      for (const part of parts) {
        await ctx.db.delete(part._id)
      }
      await ctx.db.delete(msg._id)
    }

    // Cascade: delete todos
    const todos = await ctx.db
      .query("todos")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.id))
      .collect()
    for (const todo of todos) {
      await ctx.db.delete(todo._id)
    }

    // Cascade: delete shares
    const shares = await ctx.db
      .query("sessionShares")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.id))
      .collect()
    for (const share of shares) {
      await ctx.db.delete(share._id)
    }

    await ctx.db.delete(session._id)
  },
})

export const listByProject = query({
  args: {
    project_id: v.string(),
    directory: v.optional(v.string()),
    roots: v.optional(v.boolean()),
    start: v.optional(v.number()),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let results = await ctx.db
      .query("sessions")
      .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id))
      .collect()

    if (args.directory) {
      results = results.filter((s) => s.directory === args.directory)
    }
    if (args.roots) {
      results = results.filter((s) => !s.parent_id)
    }
    if (args.start) {
      results = results.filter((s) => s.time_updated >= args.start!)
    }
    if (args.search) {
      const search = args.search.toLowerCase()
      results = results.filter((s) => s.title.toLowerCase().includes(search))
    }

    results.sort((a, b) => b.time_updated - a.time_updated)
    return results.slice(0, args.limit ?? 100)
  },
})

export const listGlobal = query({
  args: {
    directory: v.optional(v.string()),
    roots: v.optional(v.boolean()),
    start: v.optional(v.number()),
    cursor: v.optional(v.number()),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    let results = await ctx.db
      .query("sessions")
      .withIndex("by_time_updated")
      .order("desc")
      .collect()

    if (args.directory) {
      results = results.filter((s) => s.directory === args.directory)
    }
    if (args.roots) {
      results = results.filter((s) => !s.parent_id)
    }
    if (args.start) {
      results = results.filter((s) => s.time_updated >= args.start!)
    }
    if (args.cursor) {
      results = results.filter((s) => s.time_updated < args.cursor!)
    }
    if (args.search) {
      const search = args.search.toLowerCase()
      results = results.filter((s) => s.title.toLowerCase().includes(search))
    }
    if (!args.archived) {
      results = results.filter((s) => !s.time_archived)
    }

    return results.slice(0, args.limit ?? 100)
  },
})

export const listChildren = query({
  args: { project_id: v.string(), parent_id: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sessions")
      .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id))
      .filter((q) => q.eq(q.field("parent_id"), args.parent_id))
      .collect()
  },
})

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("sessions").collect()
  },
})
