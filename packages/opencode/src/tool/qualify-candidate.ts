import z from "zod"
import { Effect } from "effect"
import { Question } from "@/question"
import { readRequestSpecForSession } from "@/agent/request-spec"
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
import { requireVerifiedDataExtractorEvidenceForSession } from "../data/data-extractor-evidence"
import { LeanAdapter } from "../backtest/lean/adapter"
import { isLeanProfile } from "../backtest/lean/contracts"
import { compileLeanPlanV2FromActiveEvidence, executeLeanQualificationV2 } from "../backtest/lean/qualify"
import { runtimeForCandidate } from "../backtest/lean/select"
import {
  loadExperimentPlanV2,
  recordHoldoutOpenEventForPlanV2,
  saveExperimentPlanV2,
} from "../backtest/experiment-plan-store"

const parameters = z.object({
  candidateId: z.string().min(1).describe("Immutable saved candidate ID or exact saved algorithm name"),
  experimentPlanId: z.string().min(8).optional().describe(
    "Controller-created ExperimentPlanV1 ID. Omit on the first call so runtime code compiles it from the active RequestSpec, verified evidence, and saved strategy constraints.",
  ),
})

interface QualificationToolMetadata {
  qualified: boolean
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

function blocked(input: { planId?: string; code: string; field: string; message: string; next: string }) {
  return {
    title: "Qualification blocked",
    metadata: {
      qualified: false,
      experimentPlanId: input.planId,
      blockerCode: input.code,
      completedPhases: [],
    } satisfies QualificationToolMetadata,
    output: JSON.stringify({
      ok: false,
      experimentPlanId: input.planId,
      blocker: {
        schema: "finny.qualification_blocker",
        version: 1,
        code: input.code,
        field: input.field,
        message: input.message,
        nextAllowedTransition: input.next,
      },
    }, null, 2),
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
  candidate: Awaited<ReturnType<typeof Algorithm.resolve>> & {}
  evidence: Awaited<ReturnType<typeof requireVerifiedDataExtractorEvidenceForSession>>
  question: Question.Interface
  holdoutQuestion: typeof holdoutQuestion
  approved: typeof approved
}) {
  const { params, ctx, candidate, evidence, question, holdoutQuestion, approved } = input
  if (!evidence.ok) throw new Error("LEAN qualification requires verified evidence")
  const adapter = new LeanAdapter()
  const probe = adapter.probeReady()
  if (!probe.ready) {
    return blocked({
      code: "lean_runtime_unavailable",
      field: "runtime",
      message: `LEAN runtime is not ready: ${probe.reasons.join("; ")}`,
      next: "activate FINNY_LEAN_ENABLED, the adapter certificate, and the pinned engine image",
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
      const response = await Effect.runPromise(question.askWithId({
        sessionID: ctx.sessionID,
        questions: [holdoutQuestion(plan.planId, plan.planHash, policy.policyId)],
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      }))
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

export const QualifyCandidateTool = Tool.define<typeof parameters, QualificationToolMetadata, Question.Service, "qualify_candidate">(
  "qualify_candidate",
  Effect.gen(function* () {
    const question = yield* Question.Service
    return {
      description:
        "Compile and execute one legal qualification workflow for a saved candidate. Omit experimentPlanId on the first call: runtime code derives all timestamps from the active immutable request and authoritative evidence. Subsequent calls resume durable phase attempts and request structured user approval before opening the sealed holdout.",
      parameters,
      execute: (params, ctx) => Effect.promise(async () => {
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
        if (isLeanProfile(leanRuntime.profile)) {
          return runLeanQualificationFlow({
            params,
            ctx,
            candidate,
            evidence,
            question,
            holdoutQuestion,
            approved,
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
          const plan = await compileAndSaveExperimentPlanV1(await compileInputFromActiveEvidence({
            request,
            dataset: evidence.dataset,
            candidate,
            policy: DEFAULT_QUALIFICATION_POLICY_V1,
          }))
          return blocked({
            planId: plan.planId,
            code: plan.datasetEvidence.qualification === "strict_qualified" ? "sealed_holdout_required" : "dataset_not_strict_qualified",
            field: plan.datasetEvidence.qualification === "strict_qualified" ? "holdoutOpenEvents" : "datasetQualification",
            message: plan.datasetEvidence.qualification === "strict_qualified"
              ? "the legal plan is compiled and the sealed holdout awaits structured user approval"
              : "the legal plan is compiled, but the active evidence lacks an authoritative runtime-issued strict_qualified attestation",
            next: plan.datasetEvidence.qualification === "strict_qualified"
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
        if (!candidateMatchesExperimentPlanV1({
          plan,
          candidateId: candidate.algorithmId,
          ...executionIdentity,
        })) {
          return blocked({
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
            planId: plan.planId,
            code: "plan_dataset_mismatch",
            field: "experimentPlanId",
            message: "active DatasetEvidence does not match the immutable experiment plan",
            next: "omit experimentPlanId to compile a new plan from the active authoritative DatasetEvidence",
          })
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
            const response = await Effect.runPromise(question.askWithId({
              sessionID: ctx.sessionID,
              questions: [holdoutQuestion(plan.planId, plan.planHash, policy.policyId)],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            }))
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
          executePhase: ({ phase, window, qualification, walkForwardFolds }) => BacktestRunner.run({
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
              walkForwardFolds,
              costSensitivity: phase === "confirmatory" && policy.requireCostSensitivity,
              priorSelectionTrials: qualification.context.durableTrialCount - 1,
              currentSelectionTrials: 1,
            },
            qualification,
            sessionID: ctx.sessionID,
            dataSource: { kind: "verified_artifact", dataset: evidence.dataset },
          }),
        })
        return {
          title: result.ok ? "Candidate qualified" : "Qualification blocked",
          metadata: {
            qualified: result.ok,
            experimentPlanId: plan.planId,
            completedPhases: result.completedPhases,
            blockerCode: result.ok ? undefined : result.blocker.code,
            approvalRequestId,
          },
          output: JSON.stringify(result, null, 2),
        }
      }),
    }
  }),
)
