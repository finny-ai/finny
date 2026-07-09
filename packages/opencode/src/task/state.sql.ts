import { integer, index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionID } from "@/session/schema"
import { Timestamps } from "@/storage/schema.sql"

export const TaskRunTable = sqliteTable(
  "task_run",
  {
    id: text().$type<SessionID>().primaryKey(),
    parent_session_id: text().$type<SessionID>().notNull(),
    description: text().notNull(),
    subagent_type: text().notNull(),
    mode: text().notNull(),
    status: text().notNull(),
    started_at: integer(),
    finished_at: integer(),
    result_summary: text(),
    last_error: text(),
    ...Timestamps,
  },
  (table) => [index("task_run_parent_idx").on(table.parent_session_id), index("task_run_status_idx").on(table.status)],
)
