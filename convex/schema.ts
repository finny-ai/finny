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

  analyticsEvents: defineTable({
    userId: v.string(),
    deviceId: v.optional(v.string()),
    eventType: v.string(),
    algorithmId: v.optional(v.string()),
    payload: v.any(),
    timestamp: v.number(),
    source: v.optional(v.string()),
    appVersion: v.optional(v.string()),
  })
    .index("by_userId_timestamp", ["userId", "timestamp"])
    .index("by_userId_eventType", ["userId", "eventType"])
    .index("by_algorithmId", ["algorithmId"]),

  licenses: defineTable({
    license_key_hash: v.string(),
    org_id: v.string(),
    plan_type: v.union(v.literal("enterprise"), v.literal("per_head")),
    status: v.union(v.literal("active"), v.literal("expired"), v.literal("revoked")),
    active_from: v.optional(v.number()),
    active_until: v.optional(v.number()),
    max_devices_per_key: v.optional(v.number()),
    devices: v.optional(
      v.array(
        v.object({
          machine_id_hash: v.string(),
          status: v.union(v.literal("active"), v.literal("revoked")),
          first_seen_at: v.number(),
          last_seen_at: v.number(),
        }),
      ),
    ),
    time_created: v.number(),
    time_updated: v.number(),
  })
    .index("by_license_key_hash", ["license_key_hash"])
    .index("by_org_license_key_hash", ["org_id", "license_key_hash"])
    .index("by_org_id", ["org_id"])
    .index("by_status", ["status"]),

  licenseChecks: defineTable({
    request_id: v.string(),
    license_key_hash: v.string(),
    org_id: v.string(),
    machine_id_hash: v.string(),
    app_version: v.optional(v.string()),
    result: v.union(v.literal("allowed"), v.literal("denied")),
    error_code: v.optional(v.string()),
    devices_used: v.optional(v.number()),
    device_limit: v.optional(v.number()),
    metadata: v.optional(v.any()),
    timestamp: v.number(),
  })
    .index("by_request_id", ["request_id"])
    .index("by_org_license", ["org_id", "license_key_hash"])
    .index("by_org_license_machine", ["org_id", "license_key_hash", "machine_id_hash"])
    .index("by_org_license_result", ["org_id", "license_key_hash", "result"])
    .index("by_timestamp", ["timestamp"]),
})
