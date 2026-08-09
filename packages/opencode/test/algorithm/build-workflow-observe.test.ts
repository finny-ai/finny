import crypto from "node:crypto"
import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import {
  AlgorithmBuildWorkflowEventTable,
  AlgorithmBuildWorkflowTable,
} from "@opencode-ai/core/algorithm/build-workflow-schema"
import { BuildWorkflowObserve } from "@/algorithm/build-workflow/observe"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.defaultLayer)

it.live("appends stage observations without bumping workflow revision and deduplicates by event id", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const workflowId = `wf_observe_${suffix}`
    const sessionId = `ses_observe_${suffix}`
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({
      id: `project_${suffix}` as (typeof ProjectTable.$inferInsert)["id"],
      worktree: `/tmp/project_${suffix}` as (typeof ProjectTable.$inferInsert)["worktree"],
      sandboxes: [],
    })
    yield* db.insert(SessionTable).values({
      id: sessionId as (typeof SessionTable.$inferInsert)["id"],
      project_id: `project_${suffix}` as (typeof SessionTable.$inferInsert)["project_id"],
      slug: `session-${suffix}`,
      directory: `/tmp/project_${suffix}` as (typeof SessionTable.$inferInsert)["directory"],
      title: "Observe test",
      version: "1",
    })
    yield* BuildWorkflowStore.insert({
      workflowId,
      sessionId,
      workspaceSlug: `spy-1h-${suffix}`,
      intent: "build",
      newsRequired: false,
      identity: {
        symbols: {
          value: ["SPY"],
          source: { kind: "user_message", messageId: `msg_request_${suffix}` },
        },
        interval: {
          value: "1h",
          source: { kind: "user_message", messageId: `msg_request_${suffix}` },
        },
      },
      now: 10_000,
    })

    yield* BuildWorkflowObserve.observeStage({
      workflowId,
      stage: "data",
      status: "started",
      message: "collection started",
    })
    yield* BuildWorkflowObserve.observeStage({
      workflowId,
      stage: "data",
      status: "completed",
      artifactId: "run-1",
      message: "collection done",
    })
    // Duplicate of the same stage/status/artifactId must be a no-op.
    yield* BuildWorkflowObserve.observeStage({
      workflowId,
      stage: "data",
      status: "completed",
      artifactId: "run-1",
      message: "collection done",
    })

    const events = yield* db
      .select()
      .from(AlgorithmBuildWorkflowEventTable)
      .where(eq(AlgorithmBuildWorkflowEventTable.workflow_id, workflowId))
      .all()
    const observations = events.filter((event) => event.type === "backtest.stage.observation")
    expect(observations).toHaveLength(2)
    expect(observations.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2])
    expect(
      observations.every(
        (event) =>
          typeof event.payload === "object" &&
          event.payload !== null &&
          typeof (event.payload as { stage?: unknown }).stage === "string",
      ),
    ).toBe(true)

    const workflowRow = yield* db
      .select()
      .from(AlgorithmBuildWorkflowTable)
      .where(eq(AlgorithmBuildWorkflowTable.id, workflowId))
      .get()
    expect(workflowRow?.revision).toBe(0)
    expect(workflowRow?.stage).toBe("evidence_pending")
  }),
)
