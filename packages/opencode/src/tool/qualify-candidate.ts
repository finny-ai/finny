import z from "zod"
import { Effect } from "effect"
import { Question } from "@/question"
import { Database } from "@opencode-ai/core/database/database"
import { readRequestSpecForSession } from "@/agent/request-spec"
import {
  activeWorkflowForSession,
  bindWorkflowQualificationPlan,
  completeWorkflowBacktest,
  ensureWorkflowCandidate,
  failWorkflowBacktest,
  startWorkflowBacktest,
} from "@/algorithm/build-workflow/lifecycle"
import { EffectBridge } from "@/effect/bridge"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { BacktestRunner } from "../backtest/runner"
import { executeQualificationWithHoldoutApprovalV1 } from "../backtest/qualification-operation"
import { candidateMatchesExperimentPlanV1 } from "../backtest/experiment-plan"
import { DurableQualificationAttemptLedgerV1 } from "../backtest/qualification-attempt-ledger"
import {
  compileAndSaveExperimentPlanV1,
  loadExperimentPlanPolicyV1,
  loadExperimentPlanV1,
  readHoldoutOpenEventsV1,
  recordHoldoutOpenEventV1,
} from "../backtest/experiment-plan-store"
import { DEFAULT_QUALIFICATION_POLICY_V1, qualificationHash } from "../backtest/qualification-policy"
import { compileInputFromActiveEvidence } from "../backtest/qualification-runtime"
import { beginTrial, completeTrial, type ExperimentInput } from "../backtest/experiment"
import { requireVerifiedDataExtractorEvidenceForSession } from "../data/data-extractor-evidence"

const parameters = z.object({
  candidateId: z.string().min(1).describe("Immutable saved candidate ID or exact saved algorithm name"),
  experimentPlanId: z
    .string()
    .min(8)
    .optional()
    .describe(
      "Controller-created ExperimentPlanV1 ID. Omit on the first call so runtime code compiles it from the active RequestSpec, verified evidence, and saved strategy constraints.",
    ),
})

interface QualificationToolMetadata {
  qualified: boolean
  workflowRunId?: string
  experimentPlanId?: string
  blockerCode?: string
  completedPhases: string[]
  approvalRequestId?: string
}

function capitalFor(config: string | undefined): string {
  try {
    const parsed = JSON.parse(config ?? "{}")
    const value = parsed.starting_capital ?? parsed.capital ?? parsed.backtest?.capital
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "10000"
  } catch {
    return "10000"
  }
}

function blocked(input: {
  workflowRunId?: string
  planId?: string
  code: string
  field: string
  message: string
  next: string
}) {
  return {
    title: "Qualification blocked",
    metadata: {
      qualified: false,
      workflowRunId: input.workflowRunId,
      experimentPlanId: input.planId,
      blockerCode: input.code,
      completedPhases: [],
    } satisfies QualificationToolMetadata,
    output: JSON.stringify(
      {
        ok: false,
        workflowRunId: input.workflowRunId,
        experimentPlanId: input.planId,
        blocker: {
          schema: "finny.qualification_blocker",
          version: 1,
          code: input.code,
          field: input.field,
          message: input.message,
          nextAllowedTransition: input.next,
        },
      },
      null,
      2,
    ),
  }
}

function holdoutQuestion(planId: string, planHash: string, policyId: string): Question.Info {
  return {
    header: "Open holdout",
    question: [
      "Open the sealed confirmatory holdout exactly once?",
      `Experiment plan: ${planId}`,
      `Plan hash: ${planHash}`,
      `Qualification policy: ${policyId}`,
      "Approval permits the controller to run the immutable confirmatory window; it does not permit new timestamps or retries.",
    ].join("\n"),
    options: [
      { label: "Approve", description: "Open this exact sealed holdout once." },
      { label: "Reject", description: "Keep the holdout sealed." },
    ],
    multiple: false,
    custom: false,
  }
}

function approved(answers: ReadonlyArray<Question.Answer>) {
  return answers.length === 1 && answers[0]?.length === 1 && answers[0][0] === "Approve"
}

export const QualifyCandidateTool = Tool.define<
  typeof parameters,
  QualificationToolMetadata,
  Database.Service | Question.Service,
  "qualify_candidate"
>(
  "qualify_candidate",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const database = yield* Database.Service
    return {
      description:
        "Compile and execute one legal qualification workflow for a saved candidate. Omit experimentPlanId on the first call: runtime code derives all timestamps from the active immutable request and authoritative evidence. Subsequent calls resume durable phase attempts and request structured user approval before opening the sealed holdout.",
      parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          return yield* Effect.promise(async () => {
            const runWorkflow = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
              bridge.promise(Effect.provideService(effect, Database.Service, database))
            const candidate = await Algorithm.resolve(params.candidateId)
            if (!candidate) {
              return blocked({
                code: "candidate_not_found",
                field: "candidateId",
                message: `saved candidate ${params.candidateId} was not found`,
                next: "save the candidate and retry qualify_candidate with its immutable ID",
              })
            }
            const evidence = await requireVerifiedDataExtractorEvidenceForSession(ctx.sessionID)
            if (!evidence.ok) {
              return blocked({
                code: "dataset_evidence_required",
                field: "datasetEvidenceId",
                message: evidence.text,
                next: "produce authoritative DatasetEvidence for the active request and retry qualify_candidate",
              })
            }
            const request = await readRequestSpecForSession({ sessionID: ctx.sessionID })
            if (!request) {
              return blocked({
                code: "request_spec_required",
                field: "requestId",
                message: "the active session has no immutable RequestSpec",
                next: "bind an approved RequestSpec to this session and retry qualify_candidate",
              })
            }
            const activeWorkflow = await runWorkflow(activeWorkflowForSession(ctx.sessionID))
            if (!activeWorkflow) {
              return blocked({
                code: "workflow_required",
                field: "workflowRunId",
                message: "the active session has no authoritative Build WorkflowRun",
                next: "start or resume Build mode for this request, then retry qualify_candidate",
              })
            }
            const candidateWorkflow = await runWorkflow(
              ensureWorkflowCandidate({
                workflow: activeWorkflow,
                algorithm: candidate,
                dataset: evidence.dataset,
                interval: request.requested_interval ?? evidence.dataset.identity.actualInterval,
                start: request.requested_start,
                end: request.requested_end,
              }),
            )
            if (!params.experimentPlanId) {
              const compileInput = await compileInputFromActiveEvidence({
                request,
                dataset: evidence.dataset,
                candidate,
                policy: DEFAULT_QUALIFICATION_POLICY_V1,
              })
              const plan = await compileAndSaveExperimentPlanV1({
                ...compileInput,
                validationFraction: 0.2,
                confirmatoryFraction: 0.3,
              })
              await runWorkflow(bindWorkflowQualificationPlan({ workflow: candidateWorkflow.workflow, plan }))
              return blocked({
                workflowRunId: candidateWorkflow.workflow.workflowId,
                planId: plan.planId,
                code:
                  plan.datasetEvidence.qualification === "strict_qualified"
                    ? "sealed_holdout_required"
                    : "dataset_not_strict_qualified",
                field:
                  plan.datasetEvidence.qualification === "strict_qualified"
                    ? "holdoutOpenEvents"
                    : "datasetQualification",
                message:
                  plan.datasetEvidence.qualification === "strict_qualified"
                    ? "the legal plan is compiled and the sealed holdout awaits structured user approval"
                    : "the legal plan is compiled, but the active evidence lacks an authoritative runtime-issued strict_qualified attestation",
                next:
                  plan.datasetEvidence.qualification === "strict_qualified"
                    ? `retry qualify_candidate with experimentPlanId=${plan.planId} to request exact holdout approval`
                    : "obtain strict_qualified DatasetEvidence for this exact request and compile a new plan",
              })
            }
            const plan = await loadExperimentPlanV1(params.experimentPlanId)
            const policy = await loadExperimentPlanPolicyV1(plan.planId)
            const executionIdentity = {
              codeHash: qualificationHash(candidate.code),
              configHash: qualificationHash(candidate.config ?? ""),
            }
            if (
              !candidateMatchesExperimentPlanV1({
                plan,
                candidateId: candidate.algorithmId,
                ...executionIdentity,
              })
            ) {
              return blocked({
                workflowRunId: candidateWorkflow.workflow.workflowId,
                planId: plan.planId,
                code: "plan_candidate_mismatch",
                field: "candidateId",
                message: "active candidate identity, code, or config does not match the immutable experiment plan",
                next: "omit experimentPlanId to compile a new plan for this exact saved candidate version",
              })
            }
            if (
              evidence.dataset.csvSha256 !== plan.datasetEvidence.datasetHash ||
              evidence.dataset.manifestSha256 !== plan.datasetEvidence.manifestHash ||
              evidence.dataset.identity.actualInterval !== plan.request.interval
            ) {
              return blocked({
                workflowRunId: candidateWorkflow.workflow.workflowId,
                planId: plan.planId,
                code: "plan_dataset_mismatch",
                field: "experimentPlanId",
                message: "active DatasetEvidence does not match the immutable experiment plan",
                next: "omit experimentPlanId to compile a new plan from the active authoritative DatasetEvidence",
              })
            }
            const plannedWorkflow = await runWorkflow(
              bindWorkflowQualificationPlan({
                workflow: candidateWorkflow.workflow,
                plan,
              }),
            )
            const runningWorkflow = await runWorkflow(startWorkflowBacktest(plannedWorkflow))
            const experimentBase: ExperimentInput = {
              experimentId: runningWorkflow.workflowId,
              hypothesis: `The immutable candidate ${candidate.algorithmId} satisfies qualification plan ${plan.planId}.`,
              falsificationCriteria:
                "Any immutable qualification-policy gate fails in exploratory, validation, or confirmatory execution.",
              dataSnapshot: evidence.dataset.csvSha256,
              boundaries: {
                trainStart: plan.windows.exploratory.start.slice(0, 10),
                trainEnd: plan.windows.exploratory.end.slice(0, 10),
                validationEnd: plan.windows.confirmatory.start.slice(0, 10),
                testEnd: plan.windows.confirmatory.end.slice(0, 10),
              },
              permittedSearchSpace: "One immutable saved candidate and config bound to the qualification plan.",
              optimizationBudget: plan.declaredSearchBudget,
              primaryMetric: "confirmatory out-of-sample Sharpe and positive benchmark alpha",
              riskConstraints: `maximum drawdown ${(policy.maxDrawdown * 100).toFixed(0)}%; strict cost sensitivity; at least ${policy.minTrades} trades`,
              benchmark: `buy-and-hold ${evidence.dataset.identity.actualSymbol}`,
              qualityGates: {
                minDeflatedSharpe: policy.minDeflatedSharpe,
                minProbabilisticSharpe: policy.minProbabilisticSharpe,
                minOosCoverage: policy.minOosCoverage,
                minTrades: policy.minTrades,
                requireCostSensitivity: policy.requireCostSensitivity,
              },
            }
            let approvalRequestId: string | undefined
            const result = await executeQualificationWithHoldoutApprovalV1({
              candidateId: candidate.algorithmId,
              plan,
              policy,
              attemptLedger: DurableQualificationAttemptLedgerV1,
              executionIdentity,
              readHoldoutOpenEvents: () => readHoldoutOpenEventsV1(plan.planId),
              requestHoldoutApproval: async () => {
                const response = await bridge.promise(
                  question.askWithId({
                    sessionID: ctx.sessionID,
                    questions: [holdoutQuestion(plan.planId, plan.planHash, policy.policyId)],
                    tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
                  }),
                )
                approvalRequestId = String(response.requestID)
                if (!approved(response.answers)) return false
                await recordHoldoutOpenEventV1({
                  plan,
                  approvalHash: qualificationHash({
                    kind: "structured_holdout_approval",
                    questionRequestId: approvalRequestId,
                    planId: plan.planId,
                    planHash: plan.planHash,
                    policyId: policy.policyId,
                    policyHash: policy.policyHash,
                  }),
                })
                return true
              },
              executePhase: async ({ phase, window, qualification }) => {
                const holdoutEvent = qualification.context.holdoutOpenEvents[0]
                const trial = await beginTrial({
                  algorithm: candidate,
                  interval: plan.request.interval,
                  startDate: window.start.slice(0, 10),
                  endDate: window.end.slice(0, 10),
                  sessionId: ctx.sessionID,
                  experiment: {
                    ...experimentBase,
                    phase,
                    ...(phase === "confirmatory"
                      ? {
                          holdoutApproved: true,
                          approvalReason: `Approved qualification holdout event ${holdoutEvent?.eventId ?? "missing"}`,
                        }
                      : {}),
                  },
                })
                const result = await BacktestRunner.run({
                  algorithm: candidate,
                  duration: "1y",
                  interval: plan.request.interval,
                  capital: capitalFor(candidate.config),
                  startDate: window.start,
                  endDate: window.end,
                  engineMode: "strict_v2",
                  dataQualityMode: "strict",
                  source: "run",
                  robustness: {
                    regimes: true,
                    walkForwardFolds: phase === "confirmatory" ? policy.minWalkForwardFolds : 0,
                    costSensitivity: phase === "confirmatory" && policy.requireCostSensitivity,
                    // Exploratory, validation, and confirmatory are evaluations of
                    // one immutable code/config candidate, not three selections.
                    priorSelectionTrials: 0,
                    currentSelectionTrials: 1,
                  },
                  experiment: trial.reference,
                  qualification,
                  sessionID: ctx.sessionID,
                  dataSource: { kind: "verified_artifact", dataset: evidence.dataset },
                })
                await completeTrial({
                  reference: trial.reference,
                  sessionId: ctx.sessionID,
                  algorithm: candidate,
                  outcome: result.ok ? "passed" : "failed",
                  details: result.ok ? `${phase} qualification engine run completed` : result.error,
                  runId: result.ok ? result.results.runId : undefined,
                  actualDataHash: evidence.dataset.csvSha256,
                })
                return result
              },
            })
            if (result.ok) {
              await runWorkflow(
                completeWorkflowBacktest({
                  workflow: runningWorkflow,
                  experiment: { ...candidateWorkflow.experiment, workflow: runningWorkflow },
                  results: result.finalResults,
                  verdict: "recommended_for_paper",
                }),
              )
            } else {
              await runWorkflow(
                failWorkflowBacktest({
                  workflowId: runningWorkflow.workflowId,
                  reason: `${result.blocker.code}: ${result.blocker.message}`,
                }),
              )
            }
            const publicResult = result.ok
              ? {
                  ok: true,
                  workflowRunId: runningWorkflow.workflowId,
                  decision: result.decision,
                  completedPhases: result.completedPhases,
                  nextAllowedTransition: {
                    tool: "finny_review_packet",
                    algorithmName: candidate.name,
                    experimentId: runningWorkflow.workflowId,
                    conclusion: "recommended_for_paper",
                  },
                }
              : result
            return {
              title: result.ok ? "Candidate qualified" : "Qualification blocked",
              metadata: {
                qualified: result.ok,
                workflowRunId: runningWorkflow.workflowId,
                experimentPlanId: plan.planId,
                completedPhases: result.completedPhases,
                blockerCode: result.ok ? undefined : result.blocker.code,
                approvalRequestId,
              },
              output: JSON.stringify(publicResult, null, 2),
            }
          })
        }),
    }
  }),
)
