import { Database } from "@opencode-ai/core/database/database"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { and, desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import { TaskRunTable } from "./state.sql"

const runtime = makeRuntime(Database.Service, Database.defaultLayer)

function run<A>(database: Database.Interface | undefined, effect: (database: Database.Interface) => Effect.Effect<A>) {
  return database ? Effect.runPromise(effect(database)) : runtime.runPromise(effect)
}

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

  export type UpdateInput = Partial<
    Pick<
      Info,
      "description" | "subagentType" | "mode" | "status" | "startedAt" | "finishedAt" | "resultSummary" | "lastError"
    >
  >

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

  export async function get(id: SessionID | string, database?: Database.Interface): Promise<Info | undefined> {
    const row = await run(database, ({ db }) =>
      db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.id, id as SessionID))
        .get()
        .pipe(Effect.orDie),
    )
    return row ? rowToInfo(row) : undefined
  }

  export async function listByParent(
    parentSessionID: SessionID | string,
    database?: Database.Interface,
  ): Promise<Info[]> {
    const rows = await run(database, ({ db }) =>
      db
        .select()
        .from(TaskRunTable)
        .where(eq(TaskRunTable.parent_session_id, parentSessionID as SessionID))
        .orderBy(desc(TaskRunTable.time_updated), desc(TaskRunTable.id))
        .all()
        .pipe(Effect.orDie),
    )
    return rows.map(rowToInfo)
  }

  export async function upsert(input: CreateInput, database?: Database.Interface): Promise<Info> {
    const now = Date.now()
    await run(database, ({ db }) =>
      db
        .insert(TaskRunTable)
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
        .pipe(Effect.orDie),
    )
    return (await get(input.id, database))!
  }

  export async function update(
    id: SessionID | string,
    patch: UpdateInput,
    database?: Database.Interface,
  ): Promise<Info | undefined> {
    const now = Date.now()
    await run(database, ({ db }) =>
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
        .run()
        .pipe(Effect.orDie),
    )
    return get(id, database)
  }

  export async function finalizeActive(
    id: SessionID | string,
    input: {
      status: Extract<Status, "blocked" | "completed" | "failed" | "cancelled">
      resultSummary?: string | null
      lastError?: string | null
    },
    database?: Database.Interface,
  ): Promise<Info | undefined> {
    let next: Info | undefined
    await run(database, ({ db }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.id, id as SessionID))
              .get()
            if (!row) return
            const current = rowToInfo(row)
            if (isTerminal(current.status)) {
              next = current
              return
            }
            const now = Date.now()
            yield* tx
              .update(TaskRunTable)
              .set({
                status: input.status,
                finished_at: now,
                ...("resultSummary" in input ? { result_summary: input.resultSummary ?? null } : {}),
                ...("lastError" in input ? { last_error: input.lastError ?? null } : {}),
                time_updated: now,
              })
              .where(eq(TaskRunTable.id, id as SessionID))
              .run()
            const updated = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.id, id as SessionID))
              .get()
            next = updated ? rowToInfo(updated) : undefined
          }),
        )
        .pipe(Effect.orDie),
    )
    return next
  }

  /**
   * Compare-and-set transition to running. The select+update happens inside a
   * single transaction so a concurrent finalizeActive cannot land a terminal
   * status between our read and our write.
   */
  export async function markRunning(id: SessionID | string, database?: Database.Interface): Promise<Info | undefined> {
    let next: Info | undefined
    await run(database, ({ db }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.id, id as SessionID))
              .get()
            if (!row) return
            const current = rowToInfo(row)
            if (current.status === Status.running || isTerminal(current.status)) {
              next = current
              return
            }
            const now = Date.now()
            yield* tx
              .update(TaskRunTable)
              .set({
                status: Status.running,
                started_at: current.startedAt ?? now,
                finished_at: null,
                time_updated: now,
              })
              .where(eq(TaskRunTable.id, id as SessionID))
              .run()
            const updated = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.id, id as SessionID))
              .get()
            next = updated ? rowToInfo(updated) : undefined
          }),
        )
        .pipe(Effect.orDie),
    )
    return next
  }

  export async function cancel(id: SessionID | string, database?: Database.Interface): Promise<Info | undefined> {
    return finalizeActive(id, { status: Status.cancelled, lastError: null }, database)
  }

  export async function listRunningByParent(
    parentSessionID: SessionID | string,
    database?: Database.Interface,
  ): Promise<Info[]> {
    const rows = await run(database, ({ db }) =>
      db
        .select()
        .from(TaskRunTable)
        .where(
          and(
            eq(TaskRunTable.parent_session_id, parentSessionID as SessionID),
            eq(TaskRunTable.status, Status.running),
          ),
        )
        .orderBy(desc(TaskRunTable.time_updated), desc(TaskRunTable.id))
        .all()
        .pipe(Effect.orDie),
    )
    return rows.map(rowToInfo)
  }
}
