import { and, desc, eq } from "@/storage/db"
import { Database } from "@/storage/db"
import type { SessionID } from "@/session/schema"
import { TaskRunTable } from "./state.sql"

export namespace TaskState {
  export const Status = {
    queued: "queued",
    running: "running",
    blocked: "blocked",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
  } as const

  export type Status = (typeof Status)[keyof typeof Status]

  export type Info = {
    id: SessionID
    parentSessionID: SessionID
    description: string
    subagentType: string
    mode: string
    status: Status
    startedAt?: number
    finishedAt?: number
    resultSummary?: string
    lastError?: string
    createdAt: number
    updatedAt: number
  }

  export type CreateInput = {
    id: SessionID
    parentSessionID: SessionID
    description: string
    subagentType: string
    mode: string
    status?: Status
    startedAt?: number
    finishedAt?: number
    resultSummary?: string
    lastError?: string
  }

  export type UpdateInput = Partial<Pick<Info, "description" | "subagentType" | "mode" | "status" | "startedAt" | "finishedAt" | "resultSummary" | "lastError">>

  function rowToInfo(row: typeof TaskRunTable.$inferSelect): Info {
    return {
      id: row.id,
      parentSessionID: row.parent_session_id,
      description: row.description,
      subagentType: row.subagent_type,
      mode: row.mode,
      status: row.status as Status,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      resultSummary: row.result_summary ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
    }
  }

  export function isTerminal(status: Status) {
    switch (status) {
      case Status.blocked:
      case Status.completed:
      case Status.failed:
      case Status.cancelled:
        return true
      default:
        return false
    }
  }

  export async function get(id: SessionID | string): Promise<Info | undefined> {
    const row = Database.use((db) => db.select().from(TaskRunTable).where(eq(TaskRunTable.id, id as SessionID)).get())
    return row ? rowToInfo(row) : undefined
  }

  export async function listByParent(parentSessionID: SessionID | string): Promise<Info[]> {
    const rows = Database.use((db) =>
      db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.parent_session_id, parentSessionID as SessionID))
        .orderBy(desc(TaskRunTable.time_updated), desc(TaskRunTable.id))
        .all(),
    )
    return rows.map(rowToInfo)
  }

  export async function upsert(input: CreateInput): Promise<Info> {
    const now = Date.now()
    Database.transaction((db) => {
      db.insert(TaskRunTable)
        .values({
          id: input.id,
          parent_session_id: input.parentSessionID,
          description: input.description,
          subagent_type: input.subagentType,
          mode: input.mode,
          status: input.status ?? Status.queued,
          started_at: input.startedAt ?? null,
          finished_at: input.finishedAt ?? null,
          result_summary: input.resultSummary ?? null,
          last_error: input.lastError ?? null,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: TaskRunTable.id,
          set: {
            parent_session_id: input.parentSessionID,
            description: input.description,
            subagent_type: input.subagentType,
            mode: input.mode,
            status: input.status ?? Status.queued,
            started_at: input.startedAt ?? null,
            finished_at: input.finishedAt ?? null,
            result_summary: input.resultSummary ?? null,
            last_error: input.lastError ?? null,
            time_updated: now,
          },
        })
        .run()
    })
    return (await get(input.id))!
  }

  export async function update(id: SessionID | string, patch: UpdateInput): Promise<Info | undefined> {
    const now = Date.now()
    Database.use((db) =>
      db
        .update(TaskRunTable)
        .set({
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.subagentType !== undefined ? { subagent_type: patch.subagentType } : {}),
          ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
          ...(patch.finishedAt !== undefined ? { finished_at: patch.finishedAt } : {}),
          ...(patch.resultSummary !== undefined ? { result_summary: patch.resultSummary } : {}),
          ...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
          time_updated: now,
        })
        .where(eq(TaskRunTable.id, id as SessionID))
        .run(),
    )
    return get(id)
  }

  export async function finalizeActive(
    id: SessionID | string,
    input: { status: Extract<Status, "blocked" | "completed" | "failed" | "cancelled">; resultSummary?: string; lastError?: string },
  ): Promise<Info | undefined> {
    let next: Info | undefined
    Database.transaction((db) => {
      const row = db.select().from(TaskRunTable).where(eq(TaskRunTable.id, id as SessionID)).get()
      if (!row) return
      const current = rowToInfo(row)
      if (isTerminal(current.status)) {
        next = current
        return
      }
      const now = Date.now()
      db.update(TaskRunTable)
        .set({
          status: input.status,
          finished_at: now,
          ...(input.resultSummary !== undefined ? { result_summary: input.resultSummary } : {}),
          ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
          time_updated: now,
        })
        .where(eq(TaskRunTable.id, id as SessionID))
        .run()
      const updated = db.select().from(TaskRunTable).where(eq(TaskRunTable.id, id as SessionID)).get()
      next = updated ? rowToInfo(updated) : undefined
    })
    return next
  }

  export async function markRunning(id: SessionID | string): Promise<Info | undefined> {
    const current = await get(id)
    if (!current || current.status === Status.running) return current
    if (isTerminal(current.status)) return current
    return update(id, { status: Status.running, startedAt: current.startedAt ?? Date.now(), finishedAt: undefined })
  }

  export async function cancel(id: SessionID | string): Promise<Info | undefined> {
    return finalizeActive(id, { status: Status.cancelled, lastError: undefined })
  }

  export async function listRunningByParent(parentSessionID: SessionID | string): Promise<Info[]> {
    const rows = Database.use((db) =>
      db
        .select()
        .from(TaskRunTable)
        .where(
          and(eq(TaskRunTable.parent_session_id, parentSessionID as SessionID), eq(TaskRunTable.status, Status.running)),
        )
        .orderBy(desc(TaskRunTable.time_updated), desc(TaskRunTable.id))
        .all(),
    )
    return rows.map(rowToInfo)
  }
}
