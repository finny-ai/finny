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
import { LeanAdapter } from "../backtest/lean/adapter"
import { isLeanProfile } from "../backtest/lean/contracts"
import { compileLeanPlanV2FromActiveEvidence, executeLeanQualificationV2 } from "../backtest/lean/qualify"
import { runtimeForCandidate } from "../backtest/lean/select"
import { getProjectLink } from "@/integration/qc-store"
import {
  runQcCompositeQualification,
  writeQcCompositeEvidence,
  type QcLocalRunOutcome,
} from "@/integration/qc-composite"
import { strictRunDir } from "@/backtest/run-integrity-core"
import {
  loadExperimentPlanV2,
  recordHoldoutOpenEventForPlanV2,
  saveExperimentPlanV2,
} from "../backtest/experiment-plan-store"

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

/**
 * LEAN qualification flow. Compiles a V2 plan on first call, then resumes
 * durable phase attempts and requests exact holdout approval before the
 * confirmatory window. Mirrors the V1 tool contract; every execution goes
 * through the certified LeanAdapter and never falls back to engine_v2.
 */
async function runLeanQualificationFlow(input: {
  params: z.infer<typeof parameters>
  ctx: Tool.Context
  bridge: EffectBridge.Shape
  candidate: Awaited<ReturnType<typeof Algorithm.resolve>> & {}
  evidence: Awaited<ReturnType<typeof requireVerifiedDataExtractorEvidenceForSession>>
  question: Question.Interface
  holdoutQuestion: typeof holdoutQuestion
  approved: typeof approved
}) {
  const { params, ctx, bridge, candidate, evidence, question, holdoutQuestion, approved } = input
  if (!evidence.ok) throw new Error("LEAN qualification requires verified evidence")
  const adapter = new LeanAdapter()
  const probe = adapter.probeReady()
  if (!probe.ready) {
    return blocked({
      code: "lean_runtime_unavailable",
      field: "runtime",
      message: `LEAN runtime is not ready: ${probe.reasons.join("; ")}`,
      next: "enable the LEAN engine (Settings or `lean enable`), the adapter certificate, and the pinned engine image",
    })
  }

  if (!params.experimentPlanId) {
    const request = await readRequestSpecForSession({ sessionID: ctx.sessionID })
    if (!request) {
      return blocked({
        code: "request_spec_required",
        field: "requestId",
        message: "the active session has no immutable RequestSpec",
        next: "bind an approved RequestSpec to this session and retry qualify_candidate",
      })
    }
    const plan = await compileLeanPlanV2FromActiveEvidence({
      request,
      dataset: evidence.dataset,
      candidate,
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
    })
    await saveExperimentPlanV2(plan, DEFAULT_QUALIFICATION_POLICY_V1)
    const strict = Boolean((evidence.dataset as any).qualificationAttestation)
    return blocked({
      planId: plan.planId,
      code: strict ? "sealed_holdout_required" : "dataset_not_strict_qualified",
      field: strict ? "holdoutOpenEvents" : "datasetQualification",
      message: strict
        ? "the LEAN V2 plan is compiled and the sealed holdout awaits structured user approval"
        : "the LEAN V2 plan is compiled, but the active evidence lacks an authoritative strict_qualified attestation",
      next: strict
        ? `retry qualify_candidate with experimentPlanId=${plan.planId} to request exact holdout approval`
        : "obtain strict_qualified DatasetEvidence for this exact request and compile a new plan",
    })
  }

  const plan = await loadExperimentPlanV2(params.experimentPlanId)
  const policy = await loadExperimentPlanPolicyV1(plan.planId)
  const executionIdentity = {
    codeHash: qualificationHash(candidate.code),
    configHash: qualificationHash(candidate.config ?? ""),
  }
  if (
    plan.candidate.candidateId !== candidate.algorithmId ||
    plan.candidate.codeHash !== executionIdentity.codeHash ||
    plan.candidate.configHash !== executionIdentity.configHash
  ) {
    return blocked({
      planId: plan.planId,
      code: "plan_candidate_mismatch",
      field: "candidateId",
      message: "active candidate identity, code, or config does not match the immutable LEAN V2 plan",
      next: "omit experimentPlanId to compile a new plan for this exact saved candidate version",
    })
  }
  if (
    evidence.dataset.csvSha256 !== plan.datasets[0]?.datasetHash ||
    evidence.dataset.manifestSha256 !== plan.datasets[0]?.manifestHash
  ) {
    return blocked({
      planId: plan.planId,
      code: "plan_dataset_mismatch",
      field: "experimentPlanId",
      message: "active DatasetEvidence does not match the immutable LEAN V2 plan",
      next: "omit experimentPlanId to compile a new plan from the active authoritative DatasetEvidence",
    })
  }

  let approvalRequestId: string | undefined
  const result = await executeLeanQualificationV2({
    candidate,
    dataset: evidence.dataset,
    plan,
    policy,
    executionIdentity,
    adapter,
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
      await recordHoldoutOpenEventForPlanV2({
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
  })
  return {
    title: result.ok ? "Candidate qualified" : "Qualification blocked",
    metadata: {
      qualified: result.ok,
      experimentPlanId: plan.planId,
      completedPhases: result.completedPhases,
      blockerCode: result.ok ? undefined : result.blocker?.code,
      approvalRequestId,
    } satisfies QualificationToolMetadata,
    output: JSON.stringify(result, null, 2),
  }
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
            const leanRuntime = runtimeForCandidate(candidate)
            if (leanRuntime.issues.length > 0) {
              return blocked({
                code: "candidate_invalid",
                field: "runtime",
                message: `runtime declaration is invalid: ${leanRuntime.issues.join("; ")}`,
                next: "repair and resave the candidate with an explicit supported runtime profile",
              })
            }
            if (leanRuntime.profile.profileId === "qc_cloud") {
              const qcLink = await getProjectLink(candidate.algorithmId)
              if (!qcLink) {
                return blocked({
                  code: "candidate_invalid",
                  field: "runtime",
                  message:
                    "qc_cloud candidates must link a QuantConnect project (qc link) before composite qualification",
                  next: "link the QC project and retry; no local engine fallback is permitted",
                })
              }
              const localResult = await runLeanQualificationFlow({
                params,
                ctx,
                bridge,
                candidate,
                evidence,
                question,
                holdoutQuestion,
                approved,
              })
              if (localResult.metadata?.qualified !== true) return localResult
              // Local strict leg passed — the linked QC project must now
              // independently pass its native-cloud gates.
              const workflow = await runWorkflow(activeWorkflowForSession(ctx.sessionID))
              const runId = workflow?.backtest?.runId ?? ""
              const identityHash = workflow?.backtest?.identityHash ?? ""
              let qcConfig: Record<string, any> = {}
              try {
                qcConfig = JSON.parse(candidate.config ?? "{}")
              } catch {}
              const localRef: QcLocalRunOutcome = {
                ok: true,
                runId,
                identityHash,
                runtimeHash: "",
                engine: qcLink.language === "csharp" ? "lean_csharp" : "lean_python",
                verdict: "recommended_for_paper",
                metrics: {},
              }
              const composite = await runQcCompositeQualification({
                algorithm: candidate,
                interval: typeof qcConfig.interval === "string" ? qcConfig.interval : "5m",
                capital:
                  typeof qcConfig.equity_usd === "number"
                    ? qcConfig.equity_usd
                    : typeof qcConfig.risk?.starting_equity_usd === "number"
                      ? qcConfig.risk.starting_equity_usd
                      : 10000,
                startDate: qcConfig.backtest?.start_date ?? "",
                endDate: qcConfig.backtest?.end_date ?? "",
                local: localRef,
              })
              if (!composite.ok || !composite.identity) {
                return blocked({
                  code: "qc_cloud_gates_failed",
                  field: "cloud",
                  message:
                    composite.error ??
                    "the QC Cloud leg of the composite qualification did not pass its independent gates",
                  next: "inspect the QC Cloud backtest results and retry after resolving the failure",
                })
              }
              if (runId) {
                await writeQcCompositeEvidence({
                  runDir: strictRunDir(candidate, runId),
                  identity: composite.identity,
                  outcome: composite,
                })
              }
              return {
                ...localResult,
                output: JSON.stringify(
                  {
                    ...(JSON.parse(localResult.output) as Record<string, unknown>),
                    composite: {
                      projectId: composite.projectId,
                      backtestId: composite.backtestId,
                      backtestUrl: composite.backtestUrl,
                      canonical: composite.canonical,
                      cloudGates: composite.cloudGates,
                      compositeVerdict: composite.compositeVerdict,
                    },
                  },
                  null,
                  2,
                ),
              }
            }
            if (isLeanProfile(leanRuntime.profile)) {
              return runLeanQualificationFlow({
                params,
                ctx,
                bridge,
                candidate,
                evidence,
                question,
                holdoutQuestion,
                approved,
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
            const loaded = await loadExperimentPlanV1(params.experimentPlanId)
              .then(async (plan) => ({ plan, policy: await loadExperimentPlanPolicyV1(plan.planId) }))
              .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }) as const)
            if ("error" in loaded) {
              return blocked({
                workflowRunId: candidateWorkflow.workflow.workflowId,
                planId: params.experimentPlanId,
                code: "experiment_plan_unavailable",
                field: "experimentPlanId",
                message: loaded.error,
                next: "omit experimentPlanId to compile a new immutable plan for this exact candidate",
              })
            }
            const { plan, policy } = loaded
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
              executePhase: async ({ phase, window, qualification, walkForwardFolds }) => {
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
                    // Supplied by the runtime (walkForwardFoldsForPhase) so the
                    // reduced exploratory fold count stays centrally defined.
                    walkForwardFolds,
                    // preHoldoutMetricBlocker requires a passing cost-sensitivity
                    // outcome in the exploratory and validation phases whenever the
                    // policy demands one, so it has to be computed there too --
                    // gating it on `confirmatory` made that gate unsatisfiable.
                    costSensitivity: policy.requireCostSensitivity,
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
