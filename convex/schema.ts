import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
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
    checks: v.optional(
      v.array(
        v.object({
          timestamp: v.number(),
          result: v.union(v.literal("allowed"), v.literal("denied")),
          error_code: v.optional(v.string()),
          app_version: v.optional(v.string()),
          machine_id_hash: v.optional(v.string()),
          devices_used: v.optional(v.number()),
          device_limit: v.optional(v.number()),
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
})
