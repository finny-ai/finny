import { integer, real, text } from "drizzle-orm/sqlite-core"
import { sqliteTable } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

export const WatcherStateTable = sqliteTable("watcher_state", {
  job_id: text().primaryKey(),
  parent_session_id: text().notNull(),
  algorithm_id: text(),
  algorithm_name: text(),
  baseline_price: real(),
  baseline_equity: real(),
  baseline_position_qty: real(),
  last_price: real(),
  last_equity: real(),
  last_position_qty: real(),
  last_snapshot_at: integer(),
  last_material_at: integer(),
  pending_finding: text(),
  pending_status: text(),
  pending_created_at: integer(),
  pending_delivered_at: integer(),
  last_delivery_error: text(),
  ...Timestamps,
})
