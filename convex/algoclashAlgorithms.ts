import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

const brokerKind = v.union(v.literal("alpaca"), v.literal("binance"), v.literal("ibkr"))

// One row per VERSION. `algorithmId` is the lineage id (shared across all
// versions); `version` is the monotonic integer within that lineage.
//
// Version assignment is ATOMIC server-side: callers do NOT pass `version`.
// The mutation reads max(existing) + 1 inside the same Convex transaction
// that does the insert. Two concurrent saves from different devices (or a
// retry after a slow network) cannot collide because Convex serializes
// mutations on the same documents.
export const insertVersion = mutation({
  args: {
    algorithmId: v.string(),
    userId: v.string(),
    name: v.string(),
    code: v.string(),
    language: v.string(),
    status: v.string(),
    description: v.optional(v.string()),
    config: v.optional(v.string()),
    backtestCode: v.optional(v.string()),
    localPath: v.optional(v.string()),
    brokerKind: v.optional(brokerKind),
    time_created: v.number(),
    time_updated: v.number(),
  },
  handler: async (ctx, args) => {
    // Atomically compute next version: scan existing rows for this lineage
    // (always small — capped at 100 in practice) and pick max+1. The whole
    // mutation runs as a single Convex transaction, so no client-side race
    // can produce a duplicate (algorithmId, version) tuple.
    const existing = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .collect()
    let nextVersion = 1
    for (const row of existing) if (row.version >= nextVersion) nextVersion = row.version + 1

    const row = { ...args, version: nextVersion }
    await ctx.db.insert("algoclashAlgorithms", row)
    return row
  },
})

// In-place patch on the LATEST version of a lineage. Used by chat-driven
// param tweaks that don't change the strategy code itself. Does NOT bump
// version. If the user wants real history, they should re-save instead.
export const patchLatestConfig = mutation({
  args: { algorithmId: v.string(), config: v.string() },
  handler: async (ctx, args) => {
    // Inlined instead of using getLatestRow because the shared helper takes
    // `ctx: any` and TypeScript widens the row type back to its constraint
    // ({version:number}) — losing the `_id` system field we need for patch.
    const rows = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .collect()
    if (rows.length === 0) return null
    let latest = rows[0]
    for (const row of rows) if (row.version > latest.version) latest = row
    // Capture `now` once so the patched value and the returned value match.
    // Previously the return spread `latest.time_updated` (the OLD value)
    // even though the DB row was patched with a fresh timestamp — callers
    // using the return for UI state would render a stale timestamp.
    const now = Date.now()
    await ctx.db.patch(latest._id, { config: args.config, time_updated: now })
    return { ...latest, config: args.config, time_updated: now }
  },
})

// Returns the LATEST version row for the lineage. Most readers want this.
export const getById = query({
  args: { algorithmId: v.string() },
  handler: async (ctx, args) => {
    return getLatestRow(ctx, args.algorithmId)
  },
})

export const getByIdAndVersion = query({
  args: { algorithmId: v.string(), version: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId_version", (q) => q.eq("algorithmId", args.algorithmId).eq("version", args.version))
      .first()
  },
})

// Latest version of the algo with this name for this user. There may be
// multiple rows sharing (userId, name) when the user creates a v2 — the
// `by_userId_name` index returns them in insertion order, so we walk and
// keep the highest version.
export const getByName = query({
  args: { userId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_userId_name", (q) => q.eq("userId", args.userId).eq("name", args.name))
      .collect()
    if (rows.length === 0) return null
    return pickLatest(rows)
  },
})

// Latest version per algorithmId for this user. Server-side dedupe keeps
// payload small even when a user has many historical versions.
export const listByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect()
    const byLineage = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      const cur = byLineage.get(row.algorithmId)
      if (!cur || row.version > cur.version) byLineage.set(row.algorithmId, row)
    }
    return Array.from(byLineage.values()).sort((a, b) => b.time_updated - a.time_updated)
  },
})

// All versions for a single lineage, newest first. Capped at 100 — realistic
// algorithms shouldn't approach that, and a hard cap keeps the payload
// bounded for free-tier Convex.
export const listVersions = query({
  args: { algorithmId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .collect()
    return rows.sort((a, b) => b.version - a.version).slice(0, 100)
  },
})

export const updateStatus = mutation({
  args: { algorithmId: v.string(), status: v.string() },
  handler: async (ctx, args) => {
    // Status changes apply to the WHOLE lineage — promoting v3 to "live"
    // implicitly retires v1/v2 in the user's eyes.
    const rows = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .collect()
    if (rows.length === 0) return null
    const now = Date.now()
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: args.status, time_updated: now })
    }
    return { algorithmId: args.algorithmId, status: args.status, count: rows.length }
  },
})

// Deletes ALL versions of the lineage. From the My Algos page, "delete"
// means "throw out this entire algorithm and all its history".
export const remove = mutation({
  args: { algorithmId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("algoclashAlgorithms")
      .withIndex("by_algorithmId", (q) => q.eq("algorithmId", args.algorithmId))
      .collect()
    for (const row of rows) await ctx.db.delete(row._id)
    return { algorithmId: args.algorithmId, removed: rows.length }
  },
})

async function getLatestRow(ctx: any, algorithmId: string) {
  const rows = await ctx.db
    .query("algoclashAlgorithms")
    .withIndex("by_algorithmId", (q: any) => q.eq("algorithmId", algorithmId))
    .collect()
  if (rows.length === 0) return null
  return pickLatest(rows)
}

// Widen the constraint so callers (`getByName`, `listByUser`, helpers) keep
// the row's full shape — including system fields like `_id` — through the
// reducer. Without this the inferred type collapsed to `{ version: number }`
// and downstream `.patch(latest._id, …)` calls failed to typecheck.
function pickLatest<T extends { version: number }>(rows: T[]): T {
  let best = rows[0]
  for (const row of rows) if (row.version > best.version) best = row
  return best
}
