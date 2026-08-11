import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Algorithm } from "../algorithm"
import { controllerPaperApproval } from "../algorithm/build-workflow/paper-approval"
import { BuildWorkflowStore } from "../algorithm/build-workflow/store"
import {
  strictRunDir,
  verifyRunForAlgorithm,
  writePaperApproval,
} from "../backtest/run-integrity"
import { startPaperDeployment } from "@/integration/qc-execution"
import { getProjectLink } from "@/integration/qc-store"
import { Tool } from "./tool"

const parameters = z.object({
  algorithmName: z.string().describe("Name of the saved algorithm whose exact recommended run should be approved for paper trading."),
  runId: z.string().min(1).describe("Immutable strict run id to approve. Approval never defaults to the newest run."),
  qcDeployToProjectId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional QuantConnect project id to deploy this exact approved run to QC Paper. Must equal the algorithm's linked project. One confirmation both writes the approval and starts the deployment.",
    ),
  qcNodeId: z.string().optional().describe("Optional QuantConnect live node id; defaults to the first free node."),
  qcCapital: z.number().positive().optional().describe("Optional starting cash for the QuantConnect Paper brokerage (defaults to the run's effective configuration)."),
})

type ApprovalMetadata = {
  approved: boolean
  runId?: string
  runPath?: string
  identityHash?: string
  qcDeployment?: {
    deploymentId?: string
    projectId?: number | string
    status?: string
    error?: string
    idempotent?: boolean
  }
  errors?: string[]
}

async function validateDurability(dir: string, input: {
  runId: string
  algorithmId: string
  algorithmVersion: number
  verdict: string
}): Promise<string[]> {
  try {
    const report = JSON.parse(await fs.readFile(path.join(dir, "durability.json"), "utf8"))
    const errors: string[] = []
    if (report?.schema !== "finny.durability" || report?.version !== 1) errors.push("durability.json schema is invalid")
    if (report?.runId !== input.runId) errors.push("durability.json runId does not match")
    if (report?.algorithmId !== input.algorithmId || report?.algorithmVersion !== input.algorithmVersion) errors.push("durability.json algorithm version does not match")
    if (report?.verdict !== input.verdict) errors.push("durability.json verdict does not match the immutable recommendation")
    return errors
  } catch {
    return ["durability.json review baseline is missing or unreadable"]
  }
}

export const PaperApproveTool = Tool.define<typeof parameters, ApprovalMetadata, Database.Service, "finny_paper_approve">(
  "finny_paper_approve",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runWorkflow = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      Effect.runPromise(Effect.provideService(effect, Database.Service, database))
    return {
    description:
      "Publish the immutable approval receipt for one exact hash-complete recommended run after its controller-created paper challenge was approved by the user. This tool cannot ask for or create approval itself.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const algo = await Algorithm.get(params.algorithmName)
        if (!algo) {
          return {
            title: "Paper approval failed",
            output: `Algorithm "${params.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
            metadata: { approved: false, runId: params.runId } satisfies ApprovalMetadata,
          }
        }

        const integrity = await verifyRunForAlgorithm(algo, params.runId)
        const run = integrity.run
        if (!integrity.ok || !run) {
          return {
            title: "Paper approval refused",
            output: `Run ${params.runId} is not an exact hash-complete strict run for ${algo.name}: ${integrity.errors.join("; ") || "run not found"}.`,
            metadata: { approved: false, runId: params.runId, errors: integrity.errors } satisfies ApprovalMetadata,
          }
        }
        if (run.recommendation.verdict !== "recommended_for_paper") {
          return {
            title: "Paper approval refused",
            output: `Run ${params.runId} is not recommended_for_paper (verdict=${run.recommendation.verdict}).`,
            metadata: { approved: false, runId: params.runId, identityHash: run.identityHash } satisfies ApprovalMetadata,
          }
        }

        const dir = strictRunDir(algo, params.runId)
        const durabilityErrors = await validateDurability(dir, {
          runId: run.runId,
          algorithmId: run.identity.algorithmId,
          algorithmVersion: run.identity.algorithmVersion,
          verdict: run.recommendation.verdict,
        })
        if (durabilityErrors.length) {
          return {
            title: "Paper approval refused",
            output: `Run ${params.runId} has no matching durability review baseline: ${durabilityErrors.join("; ")}.`,
            metadata: { approved: false, runId: params.runId, identityHash: run.identityHash, errors: durabilityErrors } satisfies ApprovalMetadata,
          }
        }

        const workflows = await runWorkflow(BuildWorkflowStore.listBySession(ctx.sessionID))
        const authority = workflows
          .map((workflow) =>
            controllerPaperApproval(workflow, {
              algorithmId: algo.algorithmId,
              algorithmVersion: algo.version,
              runId: run.runId,
              identityHash: run.identityHash,
            }),
          )
          .find((item) => item !== undefined)
        if (!authority) {
          return {
            title: "Paper approval refused",
            output:
              `Run ${params.runId} has no matching controller-backed human approval. ` +
              "Use the paper_trading challengeId returned by finny_backtest with finny_workflow_request_approval first.",
            metadata: {
              approved: false,
              runId: run.runId,
              identityHash: run.identityHash,
              errors: ["matching controller-backed human approval is missing"],
            } satisfies ApprovalMetadata,
          }
        }

        const approved = await writePaperApproval({ dir, run, authority })
        if (params.qcDeployToProjectId !== undefined) {
          const link = await getProjectLink(algo.algorithmId)
          if (!link) {
            return {
              title: "Paper approval saved, QC deployment refused",
              output:
                `Run ${run.runId} is paper_eligible, but the algorithm is not linked to a QuantConnect project. ` +
                "Link the project (qc link) and retry the deployment with the same run.",
              metadata: {
                approved: true,
                runId: run.runId,
                runPath: path.join(dir, "run.json"),
                identityHash: run.identityHash,
                qcDeployment: { error: "algorithm is not linked to a QuantConnect project" },
              } satisfies ApprovalMetadata,
            }
          }
          if (link.projectId !== params.qcDeployToProjectId) {
            return {
              title: "Paper approval saved, QC deployment refused",
              output:
                `Run ${run.runId} is paper_eligible, but project ${params.qcDeployToProjectId} is not the linked project (${link.projectId}). ` +
                "Deployments are only allowed against the linked project for the exact approved source.",
              metadata: {
                approved: true,
                runId: run.runId,
                runPath: path.join(dir, "run.json"),
                identityHash: run.identityHash,
                qcDeployment: {
                  error: `project ${params.qcDeployToProjectId} does not match the linked project ${link.projectId}`,
                },
              } satisfies ApprovalMetadata,
            }
          }
          const deployment = await startPaperDeployment({
            algorithm: algo,
            runId: run.runId,
            authority,
            nodeId: params.qcNodeId,
            capital: params.qcCapital,
          })
          return {
            title: deployment.ok ? "Paper approved and deployed to QC" : "Paper approved, QC deployment failed",
            output:
              `Run ${run.runId} is paper_eligible through immutable approval.json bound to identity ${run.identityHash}.` +
              (deployment.ok
                ? `\nQC Paper deployment ${deployment.deploymentId} is ${deployment.status} on project ${deployment.projectId}.`
                : `\nQC Paper deployment failed: ${deployment.error}. Approval remains valid; retry the deployment with the same run.`),
            metadata: {
              approved: true,
              runId: run.runId,
              runPath: path.join(dir, "run.json"),
              identityHash: run.identityHash,
              qcDeployment: {
                deploymentId: deployment.deploymentId,
                projectId: deployment.projectId,
                status: deployment.status,
                ...(deployment.error ? { error: deployment.error } : {}),
                ...(deployment.idempotent ? { idempotent: true } : {}),
              },
            } satisfies ApprovalMetadata,
          }
        }
        return {
          title: approved.created ? "Paper approved" : "Paper already approved",
          output: `Run ${run.runId} is paper_eligible through immutable approval.json bound to identity ${run.identityHash}.`,
          metadata: {
            approved: true,
            runId: run.runId,
            runPath: path.join(dir, "run.json"),
            identityHash: run.identityHash,
          } satisfies ApprovalMetadata,
        }
      }),
    }
  }),
)
