import crypto from "node:crypto"
import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { makeApprovalChallenge } from "@/algorithm/build-workflow/state"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.defaultLayer)

it.live("persists snapshots, ordered events, revisions, and approval provenance", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const workflowId = `wf_store_${suffix}`
    const sessionId = `ses_store_${suffix}`
    const approvalMessageId = `msg_approval_${suffix}`
    const projectId = `project_${suffix}` as (typeof ProjectTable.$inferInsert)["id"]
    const storedSessionId = sessionId as (typeof SessionTable.$inferInsert)["id"]
    const storedMessageId = approvalMessageId as (typeof MessageTable.$inferInsert)["id"]
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({
      id: projectId,
      worktree: `/tmp/project_${suffix}` as (typeof ProjectTable.$inferInsert)["worktree"],
      sandboxes: [],
    })
    yield* db.insert(SessionTable).values({
      id: storedSessionId,
      project_id: projectId,
      slug: `session-${suffix}`,
      directory: `/tmp/project_${suffix}` as (typeof SessionTable.$inferInsert)["directory"],
      title: "Workflow test",
      version: "1",
    })
    yield* db.insert(MessageTable).values({
      id: storedMessageId,
      session_id: storedSessionId,
      data: {
        role: "user",
        time: { created: 10_350 },
        agent: "finny",
        model: { providerID: "test", modelID: "test" },
      },
      time_created: 10_350,
      time_updated: 10_350,
    } as typeof MessageTable.$inferInsert)
    yield* db.insert(PartTable).values({
      id: `part_approval_${suffix}` as (typeof PartTable.$inferInsert)["id"],
      message_id: storedMessageId,
      session_id: storedSessionId,
      data: {
        type: "text",
        text: "Yes, approve this exact provider change.",
        synthetic: false,
      },
    } as typeof PartTable.$inferInsert)
    const initial = yield* BuildWorkflowStore.insert({
      workflowId,
      sessionId,
      workspaceSlug: `spy-1h-${suffix}`,
      intent: "build",
      newsRequired: true,
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
    expect(initial).toMatchObject({ stage: "evidence_pending", revision: 0 })

    const dataResult = yield* BuildWorkflowStore.append({
      workflowId,
      expectedRevision: 0,
      event: {
        id: `evt_data_${suffix}`,
        type: "evidence.recorded",
        occurredAt: 10_100,
        source: { actor: "subagent" },
        evidence: {
          id: `evidence_data_${suffix}`,
          requirementId: "market_data:SPY",
          kind: "market_data",
          status: "verified",
          issues: [],
        },
      },
    })
    expect(dataResult.kind).toBe("applied")

    const conflict = yield* BuildWorkflowStore.append({
      workflowId,
      expectedRevision: 0,
      event: {
        id: `evt_conflict_${suffix}`,
        type: "evidence.recorded",
        occurredAt: 10_150,
        source: { actor: "subagent" },
        evidence: {
          id: `evidence_news_conflict_${suffix}`,
          requirementId: "news:request",
          kind: "news",
          status: "verified",
          issues: [],
        },
      },
    })
    expect(conflict).toEqual({
      kind: "revision_conflict",
      workflowId,
      expectedRevision: 0,
      actualRevision: 1,
    })

    const newsResult = yield* BuildWorkflowStore.append({
      workflowId,
      expectedRevision: 1,
      event: {
        id: `evt_news_${suffix}`,
        type: "evidence.recorded",
        occurredAt: 10_200,
        source: { actor: "subagent" },
        evidence: {
          id: `evidence_news_${suffix}`,
          requirementId: "news:request",
          kind: "news",
          status: "verified",
          issues: [],
        },
      },
    })
    expect(newsResult.kind).toBe("applied")

    const challenge = makeApprovalChallenge({
      id: `approval_${suffix}`,
      kind: "provider_change",
      scope: { from: "alpaca", to: "yfinance", symbol: "SPY" },
      reason: "The verified provider cannot cover the requested window.",
      now: 10_300,
    })
    const requested = yield* BuildWorkflowStore.append({
      workflowId,
      expectedRevision: 2,
      event: {
        id: `evt_approval_requested_${suffix}`,
        type: "approval.requested",
        occurredAt: 10_300,
        source: { actor: "tool" },
        challenge,
      },
    })
    expect(requested.kind).toBe("applied")

    const fabricatedApproval = yield* BuildWorkflowStore.append({
      workflowId,
      expectedRevision: 3,
      event: {
        id: `evt_approval_fabricated_${suffix}`,
        type: "approval.granted",
        occurredAt: 10_350,
        source: { actor: "user", messageId: `msg_missing_${suffix}` },
        challengeId: challenge.id,
        scopeHash: challenge.scopeHash,
      },
    })
    expect(fabricatedApproval).toMatchObject({
      kind: "rejected",
      decision: { code: "approval_source_not_persisted_user" },
    })

    const granted = yield* BuildWorkflowStore.append({
      workflowId,
      expectedRevision: 3,
      event: {
        id: `evt_approval_granted_${suffix}`,
        type: "approval.granted",
        occurredAt: 10_400,
        source: { actor: "user", messageId: approvalMessageId },
        challengeId: challenge.id,
        scopeHash: challenge.scopeHash,
      },
    })
    expect(granted.kind).toBe("applied")

    const state = yield* BuildWorkflowStore.get(workflowId)
    expect(state).toMatchObject({ workflowId, revision: 4, stage: "evidence_ready" })
    expect(state?.approvals[0]).toMatchObject({
      challengeId: challenge.id,
      sourceMessageId: approvalMessageId,
    })

    const storedEvents = yield* BuildWorkflowStore.events(workflowId)
    expect(storedEvents.map((event) => [event.seq, event.type])).toEqual([
      [0, "workflow.created"],
      [1, "evidence.recorded"],
      [2, "evidence.recorded"],
      [3, "approval.requested"],
      [4, "approval.granted"],
    ])
    const storedChallenges = yield* BuildWorkflowStore.challenges(workflowId)
    expect(storedChallenges).toEqual([
      {
        ...challenge,
        status: "approved",
        sourceMessageId: approvalMessageId,
        resolvedAt: 10_400,
      },
    ])

    const projection = yield* BuildWorkflowStore.projection(workflowId)
    expect(projection).toMatchObject({
      source_of_truth: "algorithm_build_workflow",
      workflow_id: workflowId,
      workflow_revision: 4,
      requested_symbol: "SPY",
      requested_interval: "1h",
    })
    expect((yield* BuildWorkflowStore.listBySession(sessionId)).map((item) => item.workflowId)).toEqual([workflowId])
  }),
)
