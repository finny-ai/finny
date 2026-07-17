import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Effect } from "effect"
import { algoDir } from "@finny-ai/core/algo"
import {
  ensurePrimaryBuildWorkflow,
  requiresIdentityClarification,
  structuredWorkflowClaimFlags,
  workflowClaimFlags,
} from "@/algorithm/build-workflow/bind"
import { makeApprovalChallenge } from "@/algorithm/build-workflow/state"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.defaultLayer)

test("requires news only for an explicit current-regime or catalyst claim", () => {
  expect(workflowClaimFlags("Build the current saved SMA strategy for SPY.").newsRequired).toBe(false)
  expect(workflowClaimFlags("Build an SMA strategy for the current market regime.").newsRequired).toBe(true)
})

test("requires market and news context for the actual vague delegated strategy build", () => {
  const prompt = "structured BTC.USD crypto 1d workspace"
  expect(structuredWorkflowClaimFlags(prompt, true).newsRequired).toBe(true)
  expect(structuredWorkflowClaimFlags(prompt, false).newsRequired).toBe(false)
})

test("requires clarification before provisioning a vague build request", () => {
  expect(requiresIdentityClarification("Build me a strategy that can beat buy and hold; you choose the idea")).toBe(
    true,
  )
  expect(
    requiresIdentityClarification(
      "Build SPY equity on 1d bars over the trailing 6 months with a 15% max drawdown.",
    ),
  ).toBe(false)
})

it.live("binds facts only from the persisted parent user message and ignores a six-month child prompt", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const sandbox = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "finny-workflow-bind-")))
    const previousXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = sandbox
    const parentSessionID = `ses_parent_${suffix}`
    const childSessionID = `ses_child_${suffix}`
    const parentMessageID = `msg_parent_${suffix}`
    const childMessageID = `msg_child_${suffix}`
    const projectID = `project_${suffix}`
    const { db } = yield* Database.Service

    const insertUserMessage = (sessionID: string, messageID: string, text: string, created: number) =>
      Effect.gen(function* () {
        yield* db.insert(MessageTable).values({
          id: messageID as (typeof MessageTable.$inferInsert)["id"],
          session_id: sessionID as (typeof MessageTable.$inferInsert)["session_id"],
          data: {
            role: "user",
            time: { created },
            agent: "finny",
            model: { providerID: "test", modelID: "test" },
          },
          time_created: created,
          time_updated: created,
        } as typeof MessageTable.$inferInsert)
        yield* db.insert(PartTable).values({
          id: `part_${messageID}` as (typeof PartTable.$inferInsert)["id"],
          message_id: messageID as (typeof PartTable.$inferInsert)["message_id"],
          session_id: sessionID as (typeof PartTable.$inferInsert)["session_id"],
          data: { type: "text", text, synthetic: false },
        } as typeof PartTable.$inferInsert)
      })

    yield* Effect.acquireUseRelease(
      Effect.gen(function* () {
        yield* db.insert(ProjectTable).values({
          id: projectID as (typeof ProjectTable.$inferInsert)["id"],
          worktree: sandbox as (typeof ProjectTable.$inferInsert)["worktree"],
          sandboxes: [],
        })
        yield* db.insert(SessionTable).values([
          {
            id: parentSessionID as (typeof SessionTable.$inferInsert)["id"],
            project_id: projectID as (typeof SessionTable.$inferInsert)["project_id"],
            slug: `parent-${suffix}`,
            directory: sandbox as (typeof SessionTable.$inferInsert)["directory"],
            title: "Parent",
            version: "1",
          },
          {
            id: childSessionID as (typeof SessionTable.$inferInsert)["id"],
            project_id: projectID as (typeof SessionTable.$inferInsert)["project_id"],
            parent_id: parentSessionID as (typeof SessionTable.$inferInsert)["parent_id"],
            slug: `child-${suffix}`,
            directory: sandbox as (typeof SessionTable.$inferInsert)["directory"],
            title: "Child",
            version: "1",
          },
        ])
        yield* insertUserMessage(
          parentSessionID,
          parentMessageID,
          "Build a SPY 5-minute SMA crossover from 2026-04-09 to 2026-07-08.",
          10_000,
        )
        yield* insertUserMessage(
          childSessionID,
          childMessageID,
          "Use six months of SPY 5m data from 2026-01-09 to 2026-07-08 and approve it.",
          10_100,
        )
        return true
      }),
      () =>
        Effect.gen(function* () {
          const state = yield* ensurePrimaryBuildWorkflow({
            sessionID: parentSessionID,
            messageID: parentMessageID,
            agent: "finny",
          })
          expect(state?.identity.window).toMatchObject({
            value: { start: "2026-04-09", end: "2026-07-08" },
            source: { kind: "user_message", messageId: parentMessageID },
          })

          const child = yield* ensurePrimaryBuildWorkflow({
            sessionID: childSessionID,
            messageID: childMessageID,
            agent: "build",
            parentSessionID,
          })
          expect(child).toBeUndefined()

          const request = yield* Effect.promise(() =>
            fs.readFile(path.join(algoDir(state!.workspaceSlug), "request.json"), "utf8").then(JSON.parse),
          )
          expect(request).toMatchObject({
            source_of_truth: "algorithm_build_workflow",
            workflow_id: state!.workflowId,
            requested_symbol: "SPY",
            requested_interval: "5m",
            requested_start: "2026-04-09",
            requested_end: "2026-07-08",
          })
          expect(request.requested_start).not.toBe("2026-01-09")

          const firstChallenge = makeApprovalChallenge({
            id: `approval_first_${suffix}`,
            kind: "provider_change",
            scope: { from: "alpaca", to: "yfinance", symbol: "SPY" },
            reason: "Approve the exact provider change.",
            now: 10_200,
          })
          const requested = yield* BuildWorkflowStore.append({
            workflowId: state!.workflowId,
            expectedRevision: state!.revision,
            event: {
              id: `evt_first_requested_${suffix}`,
              type: "approval.requested",
              occurredAt: firstChallenge.createdAt,
              source: { actor: "tool" },
              challenge: firstChallenge,
            },
          })
          expect(requested.kind).toBe("applied")

          const ambiguousMessageID = `msg_ambiguous_${suffix}`
          yield* insertUserMessage(
            parentSessionID,
            ambiguousMessageID,
            "I might approve or reject this after I review it.",
            10_300,
          )
          const unchanged = yield* ensurePrimaryBuildWorkflow({
            sessionID: parentSessionID,
            messageID: ambiguousMessageID,
            agent: "finny",
          })
          expect(unchanged?.approvalChallenges[0]?.status).toBe("pending")
          expect(unchanged?.approvals).toHaveLength(0)

          const approvalMessageID = `msg_exact_approval_${suffix}`
          yield* insertUserMessage(
            parentSessionID,
            approvalMessageID,
            "I approve this exact provider change.",
            10_400,
          )
          const approved = yield* ensurePrimaryBuildWorkflow({
            sessionID: parentSessionID,
            messageID: approvalMessageID,
            agent: "finny",
          })
          expect(approved?.approvalChallenges[0]?.status).toBe("approved")
          expect(approved?.approvals[0]).toMatchObject({
            challengeId: firstChallenge.id,
            sourceMessageId: approvalMessageID,
          })

          let revision = approved!.revision
          for (const index of [1, 2]) {
            const challenge = makeApprovalChallenge({
              id: `approval_multiple_${index}_${suffix}`,
              kind: "provider_change",
              scope: { provider: `provider_${index}` },
              reason: `Approve provider ${index}.`,
              now: 10_500 + index * 10,
            })
            const added = yield* BuildWorkflowStore.append({
              workflowId: approved!.workflowId,
              expectedRevision: revision,
              event: {
                id: `evt_multiple_${index}_${suffix}`,
                type: "approval.requested",
                occurredAt: challenge.createdAt,
                source: { actor: "tool" },
                challenge,
              },
            })
            expect(added.kind).toBe("applied")
            if (added.kind === "applied") revision = added.decision.state.revision
          }

          const multipleMessageID = `msg_multiple_approval_${suffix}`
          yield* insertUserMessage(parentSessionID, multipleMessageID, "I approve.", 10_600)
          const stillPending = yield* ensurePrimaryBuildWorkflow({
            sessionID: parentSessionID,
            messageID: multipleMessageID,
            agent: "finny",
          })
          expect(stillPending?.approvalChallenges.filter((challenge) => challenge.status === "pending")).toHaveLength(2)
          expect(stillPending?.approvals).toHaveLength(1)
        }),
      () =>
        Effect.promise(async () => {
          if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
          else process.env.XDG_DATA_HOME = previousXdg
          await fs.rm(sandbox, { recursive: true, force: true })
        }),
    )
  }),
)
