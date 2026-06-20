import { integer, index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionID } from "@/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Timestamps } from "@/storage/schema.sql"

export const TaskRunTable = sqliteTable(
  "task_run",
  {
    id: text()
      .$type<SessionID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
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
