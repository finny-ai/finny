import { createHash } from "node:crypto"
import {
  AlgorithmBuildWorkflowEventTable,
  AlgorithmBuildWorkflowTable,
} from "@opencode-ai/core/algorithm/build-workflow-schema"
import { Database } from "@opencode-ai/core/database/database"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { asc, desc, eq, max } from "drizzle-orm"
import { Effect } from "effect"
import { BuildWorkflowStore } from "./store"
import type { WorkflowActorKind } from "./types"

export type CrucibleStage =
  | "data"
  | "base"
  | "walk_forward"
  | "monte_carlo"
  | "regimes"
  | "consistency"
  | "alpha_decay"
  | "verdict"
  | "durability"
  | "review_packet"

export type CrucibleStageStatus = "started" | "checkpoint" | "completed" | "blocked" | "failed"

export const observeStage = Effect.fn("BuildWorkflowObserve.observeStage")(function* (input: {
  workflowId: string
  stage: CrucibleStage
  status: CrucibleStageStatus
  message?: string
  artifactId?: string
  source?: WorkflowActorKind
}) {
  const { db } = yield* Database.Service
  const hash = createHash("sha256")
    .update(input.artifactId ?? "")
    .digest("hex")
    .slice(0, 20)
  const id = `${input.workflowId}:obs:${input.stage}:${input.status}:${hash}`
  const payload = {
    stage: input.stage,
    status: input.status,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
  }
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const cursor = yield* tx
        .select({ seq: max(AlgorithmBuildWorkflowEventTable.seq) })
        .from(AlgorithmBuildWorkflowEventTable)
        .where(eq(AlgorithmBuildWorkflowEventTable.workflow_id, input.workflowId))
        .get()
      yield* tx
        .insert(AlgorithmBuildWorkflowEventTable)
        .values({
          id,
          workflow_id: input.workflowId,
          seq: (cursor?.seq ?? -1) + 1,
          type: "backtest.stage.observation",
          payload,
          source_kind: input.source ?? "system",
          time_created: Date.now(),
        })
        .onConflictDoNothing()
        .run()
    }),
  )
})

export const listRecentWorkflows = Effect.fn("BuildWorkflowObserve.listRecentWorkflows")(function* (input?: {
  limit?: number
  sessionID?: string
}) {
  const { db } = yield* Database.Service
  const limit = Math.max(1, Math.min(input?.limit ?? 200, 200))
  return yield* db
    .select()
    .from(AlgorithmBuildWorkflowTable)
    .where(input?.sessionID ? eq(AlgorithmBuildWorkflowTable.session_id, input.sessionID) : undefined)
    .orderBy(desc(AlgorithmBuildWorkflowTable.time_updated), desc(AlgorithmBuildWorkflowTable.id))
    .limit(limit)
    .all()
})

export const listWorkflowEvents = Effect.fn("BuildWorkflowObserve.listWorkflowEvents")(function* (workflowId: string) {
  const { db } = yield* Database.Service
  return yield* db
    .select()
    .from(AlgorithmBuildWorkflowEventTable)
    .where(eq(AlgorithmBuildWorkflowEventTable.workflow_id, workflowId))
    .orderBy(asc(AlgorithmBuildWorkflowEventTable.seq))
    .all()
})

const runtime = makeRuntime(Database.Service, Database.defaultLayer)

export async function observeStageAsync(input: {
  sessionId: string
  stage: CrucibleStage
  status: CrucibleStageStatus
  message?: string
  artifactId?: string
}): Promise<void> {
  try {
    await runtime.runPromise(() =>
      Effect.gen(function* () {
        const workflows = yield* BuildWorkflowStore.listBySession(input.sessionId)
        const workflow = workflows.find((item) => item.status === "active" || item.status === "blocked")
        if (!workflow) return
        yield* observeStage({
          workflowId: workflow.workflowId,
          stage: input.stage,
          status: input.status,
          message: input.message,
          artifactId: input.artifactId,
          source: "system",
        })
      }),
    )
  } catch {
    // Observability must never fail the backtest/tool path that emitted it.
  }
}

export * as BuildWorkflowObserve from "./observe"
