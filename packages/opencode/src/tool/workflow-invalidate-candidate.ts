import crypto from "node:crypto"
import z from "zod"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { activeWorkflowForSession } from "@/algorithm/build-workflow/lifecycle"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { Tool } from "./tool"

const parameters = z.object({})

type Metadata = {
  workflowId?: string
  candidateId?: string
  transitionCode: string
}

export const WorkflowInvalidateCandidateTool = Tool.define<
  typeof parameters,
  Metadata,
  Database.Service,
  "finny_workflow_invalidate_candidate"
>(
  "finny_workflow_invalidate_candidate",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      Effect.provideService(effect, Database.Service, database)

    return {
      description:
        "Invalidate the active saved workflow candidate so replacement evidence can be recorded. Use this recovery operation after an evidence_locked rejection. The immutable candidate, evidence, and backtest history remain preserved.",
      parameters,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          const workflow = yield* run(activeWorkflowForSession(ctx.sessionID))
          if (!workflow) {
            return {
              title: "No active build workflow",
              output: "No active build workflow exists in this session. No candidate was invalidated.",
              metadata: { transitionCode: "workflow_missing" },
            }
          }
          if (!workflow.candidate) {
            return {
              title: "No candidate to invalidate",
              output: "The active build workflow has no current candidate. No workflow state changed.",
              metadata: {
                workflowId: workflow.workflowId,
                transitionCode: "candidate_missing",
              },
            }
          }

          const candidateId = workflow.candidate.algorithmId
          const result = yield* run(
            BuildWorkflowStore.append({
              workflowId: workflow.workflowId,
              expectedRevision: workflow.revision,
              event: {
                id: `evt_candidate_invalidated_${crypto.randomUUID()}`,
                type: "candidate.invalidated",
                occurredAt: Date.now(),
                source: { actor: "tool" },
                reason: "Replacement evidence was requested through finny_workflow_invalidate_candidate.",
              },
            }),
          )
          if (result.kind !== "applied") {
            const transitionCode = result.kind === "rejected" ? result.decision.code : result.kind
            return {
              title: "Candidate was not invalidated",
              output: `The active candidate could not be invalidated (${transitionCode}). No workflow state changed.`,
              metadata: {
                workflowId: workflow.workflowId,
                candidateId,
                transitionCode,
              },
            }
          }

          return {
            title: "Workflow candidate invalidated",
            output:
              `Candidate ${candidateId} was invalidated. Its immutable history is preserved. ` +
              "Replacement evidence can now be recorded and must be frozen before another candidate is saved.",
            metadata: {
              workflowId: workflow.workflowId,
              candidateId,
              transitionCode: "transition_applied",
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
