import crypto from "node:crypto"
import z from "zod"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Question } from "@/question"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import type { ApprovalChallenge, WorkflowEvent } from "@/algorithm/build-workflow/types"
import { Tool } from "./tool"

const parameters = z.object({
  challengeId: z
    .string()
    .min(1)
    .describe("Controller-created pending approval challenge id. No model-supplied scope or approval boolean is accepted."),
})

type Metadata = {
  workflowId?: string
  challengeId?: string
  questionRequestId?: string
  approved?: boolean
  transitionCode?: string
}

export function approvalPromptForChallenge(challenge: ApprovalChallenge): Question.Info {
  return {
    header: "Approval scope",
    question: [
      challenge.reason,
      "",
      `Approval kind: ${challenge.kind}`,
      `Exact scope: ${JSON.stringify(challenge.scope)}`,
      `Scope hash: ${challenge.scopeHash}`,
    ].join("\n"),
    options: [
      { label: "Approve", description: "Approve exactly this controller-created scope." },
      { label: "Reject", description: "Reject this scope and leave the workflow unapproved." },
    ],
    multiple: false,
    custom: false,
  }
}

export function approvalDecisionFromAnswers(answers: ReadonlyArray<Question.Answer>): "approve" | "reject" {
  return answers.length === 1 && answers[0]?.length === 1 && answers[0][0] === "Approve" ? "approve" : "reject"
}

export const WorkflowRequestApprovalTool = Tool.define<
  typeof parameters,
  Metadata,
  Database.Service | Question.Service,
  "finny_workflow_request_approval"
>(
  "finny_workflow_request_approval",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const question = yield* Question.Service
    const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      Effect.provideService(effect, Database.Service, database)

    return {
      description:
        "Present a pending controller-created workflow approval scope to the user. Only the structured user response recorded by this call can approve it; userApproved and other model booleans are deprecated hints and never grant approval.",
      parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const workflows = yield* run(BuildWorkflowStore.listBySession(ctx.sessionID))
          const workflow = workflows.find((item) =>
            item.approvalChallenges.some((challenge) => challenge.id === params.challengeId && challenge.status === "pending"),
          )
          const challenge = workflow?.approvalChallenges.find((item) => item.id === params.challengeId)
          if (!workflow || !challenge || challenge.status !== "pending") {
            return {
              title: "Approval challenge unavailable",
              output: `No pending controller-created approval challenge ${params.challengeId} exists in this session. No approval was recorded.`,
              metadata: { challengeId: params.challengeId, transitionCode: "approval_challenge_missing" },
            }
          }

          const response = yield* question.askWithId({
            sessionID: ctx.sessionID,
            questions: [approvalPromptForChallenge(challenge)],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })
          const questionRequestId = String(response.requestID)
          const decision = approvalDecisionFromAnswers(response.answers)
          const latest = yield* run(BuildWorkflowStore.get(workflow.workflowId))
          const latestChallenge = latest?.approvalChallenges.find((item) => item.id === challenge.id)
          if (!latest || !latestChallenge || latestChallenge.status !== "pending" || latestChallenge.scopeHash !== challenge.scopeHash) {
            return {
              title: "Approval challenge changed",
              output: "The workflow changed while the approval question was open. No approval was recorded; request a new controller challenge.",
              metadata: {
                workflowId: workflow.workflowId,
                challengeId: challenge.id,
                questionRequestId,
                transitionCode: "approval_challenge_stale",
              },
            }
          }

          const approvalEvent: WorkflowEvent =
            decision === "approve"
              ? {
                  id: `evt_approval_${crypto.randomUUID()}`,
                  type: "approval.granted",
                  occurredAt: Date.now(),
                  source: {
                    actor: "user",
                    structuredResponse: true,
                    questionRequestId,
                  },
                  challengeId: challenge.id,
                  scopeHash: challenge.scopeHash,
                }
              : {
                  id: `evt_approval_${crypto.randomUUID()}`,
                  type: "approval.rejected",
                  occurredAt: Date.now(),
                  source: {
                    actor: "user",
                    structuredResponse: true,
                    questionRequestId,
                  },
                  challengeId: challenge.id,
                }
          const result = yield* run(
            BuildWorkflowStore.append({
              workflowId: latest.workflowId,
              expectedRevision: latest.revision,
              event: approvalEvent,
            }),
          )
          if (result.kind !== "applied") {
            const transitionCode = result.kind === "rejected" ? result.decision.code : result.kind
            return {
              title: "Approval was not recorded",
              output: `The structured response could not be applied (${transitionCode}). No approval was recorded.`,
              metadata: {
                workflowId: workflow.workflowId,
                challengeId: challenge.id,
                questionRequestId,
                transitionCode,
              },
            }
          }

          const approved = decision === "approve"
          return {
            title: approved ? "Workflow scope approved" : "Workflow scope rejected",
            output: approved
              ? `User approved challenge ${challenge.id} for exact scope hash ${challenge.scopeHash}.`
              : `User rejected challenge ${challenge.id}. No approval record was created.`,
            metadata: {
              workflowId: workflow.workflowId,
              challengeId: challenge.id,
              questionRequestId,
              approved,
              transitionCode: "transition_applied",
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
