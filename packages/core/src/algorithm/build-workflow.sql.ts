import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export const AlgorithmBuildWorkflowTable = sqliteTable(
  "algorithm_build_workflow",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    workspace_slug: text().notNull(),
    stage: text().notNull(),
    status: text().notNull(),
    revision: integer().notNull(),
    state: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("algorithm_build_workflow_session_idx").on(table.session_id),
    index("algorithm_build_workflow_workspace_idx").on(table.workspace_slug),
  ],
)

export const AlgorithmBuildWorkflowEventTable = sqliteTable(
  "algorithm_build_workflow_event",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => AlgorithmBuildWorkflowTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    source_kind: text().notNull(),
    source_message_id: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("algorithm_build_workflow_event_seq_idx").on(table.workflow_id, table.seq),
    index("algorithm_build_workflow_event_type_idx").on(table.workflow_id, table.type, table.seq),
  ],
)

export const AlgorithmBuildApprovalChallengeTable = sqliteTable(
  "algorithm_build_approval_challenge",
  {
    id: text().primaryKey(),
    workflow_id: text()
      .notNull()
      .references(() => AlgorithmBuildWorkflowTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    scope_hash: text().notNull(),
    scope: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text().notNull(),
    reason: text().notNull(),
    source_message_id: text(),
    resolved_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("algorithm_build_approval_workflow_status_idx").on(table.workflow_id, table.status),
    index("algorithm_build_approval_scope_idx").on(table.workflow_id, table.kind, table.scope_hash),
  ],
)
