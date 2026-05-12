import { eq } from "@/storage/db"
import { Database } from "@/storage/db"
import { WatcherStateTable } from "./watcher-state.sql"

export namespace WatcherState {
  export const PendingStatus = {
    pending: "pending",
    delivered: "delivered",
    notified: "notified",
  } as const

  export type PendingStatus = (typeof PendingStatus)[keyof typeof PendingStatus]

  export type Info = {
    jobID: string
    parentSessionID: string
    algorithmID?: string
    algorithmName?: string
    baselinePrice?: number
    baselineEquity?: number
    baselinePositionQty?: number
    lastPrice?: number
    lastEquity?: number
    lastPositionQty?: number
    lastSnapshotAt?: number
    lastMaterialAt?: number
    pendingFinding?: string
    pendingStatus?: PendingStatus
    pendingCreatedAt?: number
    pendingDeliveredAt?: number
    lastDeliveryError?: string
    createdAt: number
    updatedAt: number
  }

  export type UpsertInput = {
    jobID: string
    parentSessionID: string
    algorithmID?: string
    algorithmName?: string
  }

  export type SnapshotInput = {
    price?: number
    equity?: number
    positionQty?: number
    material?: boolean
    at?: number
  }

  function rowToInfo(row: typeof WatcherStateTable.$inferSelect): Info {
    return {
      jobID: row.job_id,
      parentSessionID: row.parent_session_id,
      algorithmID: row.algorithm_id ?? undefined,
      algorithmName: row.algorithm_name ?? undefined,
      baselinePrice: row.baseline_price ?? undefined,
      baselineEquity: row.baseline_equity ?? undefined,
      baselinePositionQty: row.baseline_position_qty ?? undefined,
      lastPrice: row.last_price ?? undefined,
      lastEquity: row.last_equity ?? undefined,
      lastPositionQty: row.last_position_qty ?? undefined,
      lastSnapshotAt: row.last_snapshot_at ?? undefined,
      lastMaterialAt: row.last_material_at ?? undefined,
      pendingFinding: row.pending_finding ?? undefined,
      pendingStatus: (row.pending_status as PendingStatus | null) ?? undefined,
      pendingCreatedAt: row.pending_created_at ?? undefined,
      pendingDeliveredAt: row.pending_delivered_at ?? undefined,
      lastDeliveryError: row.last_delivery_error ?? undefined,
      createdAt: row.time_created,
      updatedAt: row.time_updated,
    }
  }

  export function get(jobID: string): Info | undefined {
    const row = Database.use((db) =>
      db.select().from(WatcherStateTable).where(eq(WatcherStateTable.job_id, jobID)).get(),
    )
    return row ? rowToInfo(row) : undefined
  }

  export function list(): Info[] {
    return Database.use((db) => db.select().from(WatcherStateTable).all()).map(rowToInfo)
  }

  export function listPending(): Info[] {
    return Database.use((db) =>
      db.select().from(WatcherStateTable).where(eq(WatcherStateTable.pending_status, PendingStatus.pending)).all(),
    ).map(rowToInfo)
  }

  export function upsert(input: UpsertInput): Info {
    const now = Date.now()
    Database.transaction((db) => {
      db.insert(WatcherStateTable)
        .values({
          job_id: input.jobID,
          parent_session_id: input.parentSessionID,
          algorithm_id: input.algorithmID ?? null,
          algorithm_name: input.algorithmName ?? null,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: WatcherStateTable.job_id,
          set: {
            parent_session_id: input.parentSessionID,
            ...(input.algorithmID !== undefined ? { algorithm_id: input.algorithmID } : {}),
            ...(input.algorithmName !== undefined ? { algorithm_name: input.algorithmName } : {}),
            time_updated: now,
          },
        })
        .run()
    })
    return get(input.jobID)!
  }

  export function recordSnapshot(jobID: string, input: SnapshotInput): Info | undefined {
    const current = get(jobID)
    if (!current) return undefined
    const now = input.at ?? Date.now()
    Database.use((db) =>
      db
        .update(WatcherStateTable)
        .set({
          ...(input.price !== undefined
            ? {
                last_price: input.price,
                baseline_price: current.baselinePrice ?? input.price,
              }
            : {}),
          ...(input.equity !== undefined
            ? {
                last_equity: input.equity,
                baseline_equity: current.baselineEquity ?? input.equity,
              }
            : {}),
          ...(input.positionQty !== undefined
            ? {
                last_position_qty: input.positionQty,
                baseline_position_qty: current.baselinePositionQty ?? input.positionQty,
              }
            : {}),
          last_snapshot_at: now,
          ...(input.material ? { last_material_at: now } : {}),
          time_updated: now,
        })
        .where(eq(WatcherStateTable.job_id, jobID))
        .run(),
    )
    return get(jobID)
  }

  /**
   * Mark a finding as pending delivery. If a prior undelivered finding exists
   * for the same job (status === "pending"), the new finding is appended rather
   * than replaced — losing a finding silently because two ticks fired before
   * the first delivered would violate the design's "findings survive a restart"
   * guarantee. Status `delivered`/`notified` is treated as terminal and overwritten.
   */
  export function markPending(jobID: string, text: string): Info | undefined {
    const now = Date.now()
    const current = get(jobID)
    const merged =
      current?.pendingStatus === PendingStatus.pending && current?.pendingFinding
        ? `${current.pendingFinding}\n\n---\n\n${text}`
        : text
    Database.use((db) =>
      db
        .update(WatcherStateTable)
        .set({
          pending_finding: merged,
          pending_status: PendingStatus.pending,
          pending_created_at: current?.pendingCreatedAt ?? now,
          pending_delivered_at: null,
          last_delivery_error: null,
          time_updated: now,
        })
        .where(eq(WatcherStateTable.job_id, jobID))
        .run(),
    )
    return get(jobID)
  }

  export function markDelivered(jobID: string): Info | undefined {
    const now = Date.now()
    Database.use((db) =>
      db
        .update(WatcherStateTable)
        .set({
          pending_status: PendingStatus.delivered,
          pending_delivered_at: now,
          last_delivery_error: null,
          time_updated: now,
        })
        .where(eq(WatcherStateTable.job_id, jobID))
        .run(),
    )
    return get(jobID)
  }

  export function markNotified(jobID: string): Info | undefined {
    const now = Date.now()
    Database.use((db) =>
      db
        .update(WatcherStateTable)
        .set({
          pending_status: PendingStatus.notified,
          pending_delivered_at: now,
          last_delivery_error: null,
          time_updated: now,
        })
        .where(eq(WatcherStateTable.job_id, jobID))
        .run(),
    )
    return get(jobID)
  }

  export function markDeliveryError(jobID: string, error: string): Info | undefined {
    Database.use((db) =>
      db
        .update(WatcherStateTable)
        .set({
          last_delivery_error: error,
          time_updated: Date.now(),
        })
        .where(eq(WatcherStateTable.job_id, jobID))
        .run(),
    )
    return get(jobID)
  }
}
