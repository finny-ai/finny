import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  projects: defineTable({
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
  }).index("by_ext_id", ["id"]),

  sessions: defineTable({
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
  })
    .index("by_ext_id", ["id"])
    .index("by_project_id", ["project_id"])
    .index("by_parent_id", ["parent_id"])
    .index("by_time_updated", ["time_updated"])
    .index("by_user_id", ["user_id"]),

  messages: defineTable({
    id: v.string(),
    session_id: v.string(),
    time_created: v.number(),
    time_updated: v.number(),
    data: v.any(),
  })
    .index("by_ext_id", ["id"])
    .index("by_session_id", ["session_id"])
    .index("by_session_time", ["session_id", "time_created"]),

  parts: defineTable({
    id: v.string(),
    message_id: v.string(),
    session_id: v.string(),
    time_created: v.number(),
    time_updated: v.number(),
    data: v.any(),
  })
    .index("by_ext_id", ["id"])
    .index("by_message_id", ["message_id"])
    .index("by_session_id", ["session_id"]),

  todos: defineTable({
    session_id: v.string(),
    content: v.string(),
    status: v.string(),
    priority: v.string(),
    position: v.number(),
    time_created: v.number(),
    time_updated: v.number(),
  }).index("by_session_id", ["session_id"]),

  permissions: defineTable({
    project_id: v.string(),
    data: v.any(),
    time_created: v.number(),
    time_updated: v.number(),
  }).index("by_project_id", ["project_id"]),

  controlAccounts: defineTable({
    email: v.string(),
    url: v.string(),
    access_token: v.string(),
    refresh_token: v.string(),
    token_expiry: v.optional(v.number()),
    active: v.boolean(),
    time_created: v.number(),
    time_updated: v.number(),
  })
    .index("by_email_url", ["email", "url"])
    .index("by_active", ["active"]),

  sessionShares: defineTable({
    session_id: v.string(),
    share_id: v.string(),
    secret: v.string(),
    url: v.string(),
    time_created: v.number(),
    time_updated: v.number(),
  }).index("by_session_id", ["session_id"]),

  workspaces: defineTable({
    id: v.string(),
    type: v.string(),
    branch: v.optional(v.string()),
    name: v.optional(v.string()),
    directory: v.optional(v.string()),
    extra: v.optional(v.any()),
    project_id: v.string(),
  })
    .index("by_ext_id", ["id"])
    .index("by_project_id", ["project_id"]),

  interactions: defineTable({
    userId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    eventType: v.string(),
    eventName: v.string(),
    metadata: v.optional(v.any()),
    timestamp: v.number(),
    source: v.optional(v.string()),
    version: v.optional(v.string()),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_session", ["sessionId"])
    .index("by_project", ["projectId"]),

  algoclashUsers: defineTable({
    finnyUserId: v.string(),
    username: v.string(),
    elo: v.number(),
    rank: v.optional(v.number()),
    wins: v.number(),
    losses: v.number(),
    time_created: v.number(),
    time_updated: v.number(),
  })
    .index("by_finnyUserId", ["finnyUserId"])
    .index("by_elo", ["elo"]),

  algoclashAlgorithms: defineTable({
    algorithmId: v.string(),
    userId: v.string(),
    name: v.string(),
    code: v.string(),
    language: v.string(),
    version: v.number(),
    status: v.string(),
    description: v.optional(v.string()),
    config: v.optional(v.string()),
    backtestCode: v.optional(v.string()),
    localPath: v.optional(v.string()),
    time_created: v.number(),
    time_updated: v.number(),
  })
    // One row PER VERSION. `algorithmId` is the lineage id (shared across
    // versions), `version` is the monotonically-increasing integer within
    // that lineage. `getByName`/`listByUser` collapse to the latest version
    // per algorithmId; `listVersions` walks the whole lineage.
    .index("by_algorithmId", ["algorithmId"])
    .index("by_algorithmId_version", ["algorithmId", "version"])
    .index("by_userId", ["userId"])
    .index("by_userId_name", ["userId", "name"]),

  algoclashTrades: defineTable({
    tradeId: v.string(),
    algorithmId: v.string(),
    symbol: v.string(),
    side: v.string(),
    quantity: v.number(),
    price: v.number(),
    pnl: v.optional(v.number()),
    time_created: v.number(),
  })
    .index("by_tradeId", ["tradeId"])
    .index("by_algorithmId", ["algorithmId"]),

  algoclashPortfolios: defineTable({
    userId: v.string(),
    algorithmId: v.string(),
    holdings: v.any(),
    cash: v.number(),
    totalValue: v.number(),
    time_updated: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_algorithmId", ["algorithmId"]),

  algoclashLeaderboard: defineTable({
    period: v.string(),
    date: v.string(),
    entries: v.array(v.any()),
    time_updated: v.number(),
  }).index("by_period_date", ["period", "date"]),

  devices: defineTable({
    userId: v.string(),
    hostname: v.string(),
    username: v.string(),
    platform: v.string(),
    arch: v.string(),
    installMethod: v.optional(v.string()),
    version: v.optional(v.string()),
    channel: v.optional(v.string()),
    time_created: v.number(),
    time_updated: v.number(),
  }).index("by_userId", ["userId"]),

  emailSubscriptions: defineTable({
    email: v.string(),
    source: v.optional(v.string()),
    version: v.optional(v.string()),
    platform: v.optional(v.string()),
    deviceId: v.optional(v.string()),
    time_created: v.number(),
    time_updated: v.number(),
  }).index("by_email", ["email"]),
})
