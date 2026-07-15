import {
  AlgorithmBuildApprovalChallengeTable,
  AlgorithmBuildWorkflowEventTable,
  AlgorithmBuildWorkflowTable,
} from "@opencode-ai/core/algorithm/build-workflow-schema"
import { Database } from "@opencode-ai/core/database/database"
import { asc, desc, eq, max } from "drizzle-orm"
import { Effect } from "effect"
import { createBuildWorkflow, migrateLegacyBuildWorkflowState, requestJsonProjection } from "./state"
import { appendInTransaction, decodeState, rowToChallenge } from "./store-append"
import { WorkflowStateCorruptError } from "./store-errors"
import type {
  ApplyStoredEventResult,
  CreateBuildWorkflowInput,
  RequestJsonProjection,
  StoredWorkflowEvent,
  WorkflowEvent,
} from "./types"

// SQLite is authoritative. request.json consumers receive the typed projection
// exposed below and must not promote prompt-derived mutations back into state.

export { WorkflowStateCorruptError }

function encode(input: object): Record<string, unknown> {
  return input as Record<string, unknown>
}

export const insert = Effect.fn("BuildWorkflowStore.insert")(function* (input: CreateBuildWorkflowInput) {
  const state = createBuildWorkflow(input)
  const { db } = yield* Database.Service
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx
        .insert(AlgorithmBuildWorkflowTable)
        .values({
          id: state.workflowId,
          session_id: state.sessionId,
          workspace_slug: state.workspaceSlug,
          stage: state.stage,
          status: state.status,
          revision: state.revision,
          state: encode(state),
          time_created: state.createdAt,
          time_updated: state.updatedAt,
        })
        .run()
      yield* tx
        .insert(AlgorithmBuildWorkflowEventTable)
        .values({
          id: `${state.workflowId}:created`,
          workflow_id: state.workflowId,
          seq: 0,
          type: "workflow.created",
          payload: encode({ state }),
          source_kind: "system",
          time_created: state.createdAt,
        })
        .run()
    }),
  )
  return state
})

export const get = Effect.fn("BuildWorkflowStore.get")(function* (workflowId: string) {
  const { db } = yield* Database.Service
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const row = yield* tx
        .select()
        .from(AlgorithmBuildWorkflowTable)
        .where(eq(AlgorithmBuildWorkflowTable.id, workflowId))
        .get()
      if (!row) return undefined
      const legacy = migrateLegacyBuildWorkflowState(row.state)
      if (!legacy) return decodeState(workflowId, row.state)
      const eventCursor = yield* tx
        .select({ seq: max(AlgorithmBuildWorkflowEventTable.seq) })
        .from(AlgorithmBuildWorkflowEventTable)
        .where(eq(AlgorithmBuildWorkflowEventTable.workflow_id, workflowId))
        .get()
      yield* tx
        .update(AlgorithmBuildWorkflowTable)
        .set({
          stage: legacy.stage,
          status: legacy.status,
          revision: legacy.revision,
          state: encode(legacy),
          time_updated: legacy.updatedAt,
        })
        .where(eq(AlgorithmBuildWorkflowTable.id, workflowId))
        .run()
      yield* tx
        .insert(AlgorithmBuildWorkflowEventTable)
        .values({
          id: `${workflowId}:legacy_imported:v2`,
          workflow_id: workflowId,
          seq: (eventCursor?.seq ?? -1) + 1,
          type: "workflow.legacy_imported",
          payload: encode({ fromVersion: 1, toVersion: 2, resumeToken: legacy.resumeToken }),
          source_kind: "system",
          time_created: legacy.updatedAt,
        })
        .onConflictDoNothing()
        .run()
      return legacy
    }),
  )
})

export const listBySession = Effect.fn("BuildWorkflowStore.listBySession")(function* (sessionId: string) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(AlgorithmBuildWorkflowTable)
    .where(eq(AlgorithmBuildWorkflowTable.session_id, sessionId))
    .orderBy(desc(AlgorithmBuildWorkflowTable.time_updated), desc(AlgorithmBuildWorkflowTable.id))
    .all()
  return yield* Effect.forEach(rows, (row) => get(row.id), { concurrency: 1 }).pipe(
    Effect.map((states) => states.filter((state): state is NonNullable<typeof state> => !!state)),
  )
})

function storedEvent(row: typeof AlgorithmBuildWorkflowEventTable.$inferSelect): StoredWorkflowEvent {
  const payload = row.payload
  const persistedSource = (payload as { source?: StoredWorkflowEvent["source"] }).source
  const source = {
    actor: row.source_kind as StoredWorkflowEvent["source"]["actor"],
    messageId: row.source_message_id ?? undefined,
    questionRequestId: persistedSource?.questionRequestId,
    structuredResponse: persistedSource?.structuredResponse,
    synthetic: persistedSource?.synthetic,
  }
  return {
    id: row.id,
    workflowId: row.workflow_id,
    seq: row.seq,
    type: row.type as StoredWorkflowEvent["type"],
    payload,
    source,
    occurredAt: row.time_created,
  }
}

export const events = Effect.fn("BuildWorkflowStore.events")(function* (workflowId: string) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(AlgorithmBuildWorkflowEventTable)
    .where(eq(AlgorithmBuildWorkflowEventTable.workflow_id, workflowId))
    .orderBy(asc(AlgorithmBuildWorkflowEventTable.seq))
    .all()
  return rows.map(storedEvent)
})

export const challenges = Effect.fn("BuildWorkflowStore.challenges")(function* (workflowId: string) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(AlgorithmBuildApprovalChallengeTable)
    .where(eq(AlgorithmBuildApprovalChallengeTable.workflow_id, workflowId))
    .orderBy(asc(AlgorithmBuildApprovalChallengeTable.time_created), asc(AlgorithmBuildApprovalChallengeTable.id))
    .all()
  return rows.map(rowToChallenge)
})

export const append = Effect.fn("BuildWorkflowStore.append")(function* (input: {
  workflowId: string
  event: WorkflowEvent
  expectedRevision?: number
}) {
  const { db } = yield* Database.Service
  const result = yield* db.transaction((tx) => appendInTransaction(tx, input))
  return result as ApplyStoredEventResult
})

export const projection = Effect.fn("BuildWorkflowStore.projection")(function* (workflowId: string) {
  const state = yield* get(workflowId)
  const value: RequestJsonProjection | undefined = state ? requestJsonProjection(state) : undefined
  return value
})

export * as BuildWorkflowStore from "./store"
