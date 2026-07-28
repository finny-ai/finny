import { Algorithm } from "@/algorithm"
import { readRequestSpecForSession } from "@/agent/request-spec"
import {
  loadExperimentPlanPolicyV1,
  loadExperimentPlanV1,
  readHoldoutOpenEventsV1,
} from "@/backtest/experiment-plan-store"
import { candidateMatchesExperimentPlanV1 } from "@/backtest/experiment-plan"
import { qualifyCandidateV1, type QualifyCandidateResultV1 } from "@/backtest/qualification"
import { readQualificationAttemptEventsV1 } from "@/backtest/qualification-attempt-ledger"
import { qualificationHash } from "@/backtest/qualification-policy"
import type { BacktestRunner } from "@/backtest/runner"
import { requireVerifiedDataExtractorEvidenceForSession } from "@/data/data-extractor-evidence"

const ID_RE = /^[A-Za-z0-9._-]{8,120}$/

export class QualificationArtifactExportError extends Error {
  override readonly name = "QualificationArtifactExportError"
}

function invalid(message: string): never {
  throw new QualificationArtifactExportError(message)
}

export interface QualificationArtifactExportInputV1 {
  sessionId: string
  algorithmId: string
  experimentPlanId: string
}

export interface QualificationArtifactExportResultV1 {
  schemaVersion: 1
  sessionId: string
  algorithmId: string
  algorithmVersion: number
  algorithmName: string
  language: string
  code: string
  config: string
  codeHash: string
  configHash: string
  experimentPlanId: string
  experimentPlanHash: string
  qualificationPolicyId: string
  qualificationPolicyHash: string
  datasetEvidenceId: string
  datasetHash: string
  datasetManifestHash: string
  holdoutEventHash: string
  confirmatoryAttemptId: string
  confirmatoryResult: BacktestRunner.RunResult
  confirmatoryResultHash: string
  completedPhases: readonly ["exploratory", "validation", "confirmatory"]
  qualificationDecision: Extract<QualifyCandidateResultV1, { ok: true }>
  qualificationDecisionHash: string
  artifactEvidenceHash: string
}

function validate(input: QualificationArtifactExportInputV1) {
  if (!ID_RE.test(input.sessionId)) invalid("invalid qualification session identity")
  if (!ID_RE.test(input.algorithmId)) invalid("invalid qualification algorithm identity")
  if (!/^plan-[0-9a-f]{24}$/.test(input.experimentPlanId)) {
    invalid("invalid qualification experiment plan identity")
  }
}

async function loadQualifiedPlan(planId: string) {
  try {
    return await loadExperimentPlanV1(planId)
  } catch {
    invalid("qualified experiment plan was not found or is invalid")
  }
}

export async function exportQualificationArtifactV1(
  input: QualificationArtifactExportInputV1,
): Promise<QualificationArtifactExportResultV1> {
  validate(input)
  const [candidate, plan, request, evidence] = await Promise.all([
    Algorithm.getById(input.algorithmId),
    loadQualifiedPlan(input.experimentPlanId),
    readRequestSpecForSession({ sessionID: input.sessionId }),
    requireVerifiedDataExtractorEvidenceForSession(input.sessionId),
  ])
  if (!candidate) invalid("qualified algorithm was not found")
  if (!request) invalid("qualification session has no immutable request")
  if (!evidence.ok) invalid("qualification session has no verified dataset evidence")
  const codeHash = qualificationHash(candidate.code)
  const config = candidate.config ?? ""
  const configHash = qualificationHash(config)
  if (
    !candidateMatchesExperimentPlanV1({
      plan,
      candidateId: candidate.algorithmId,
      codeHash,
      configHash,
    })
  ) {
    invalid("qualified algorithm does not match the immutable experiment plan")
  }
  if (
    plan.request.requestId !== request.request_id ||
    plan.request.requestVersion !== request.request_version ||
    plan.request.requestHash !== request.content_hash
  ) {
    invalid("qualification request does not match the immutable experiment plan")
  }
  if (
    evidence.dataset.csvSha256 !== plan.datasetEvidence.datasetHash ||
    evidence.dataset.manifestSha256 !== plan.datasetEvidence.manifestHash ||
    evidence.dataset.qualificationAttestation?.datasetEvidenceId !== plan.datasetEvidence.datasetEvidenceId
  ) {
    invalid("qualification dataset does not match the immutable experiment plan")
  }

  const [policy, holdoutEvents, attemptEvents] = await Promise.all([
    loadExperimentPlanPolicyV1(plan.planId),
    readHoldoutOpenEventsV1(plan.planId),
    readQualificationAttemptEventsV1(plan.planId),
  ])
  if (policy.policyId !== plan.qualificationPolicyId || policy.policyHash !== plan.qualificationPolicyHash) {
    invalid("qualification policy does not match the immutable experiment plan")
  }
  if (
    holdoutEvents.length !== 1 ||
    holdoutEvents[0]?.planId !== plan.planId ||
    holdoutEvents[0]?.planHash !== plan.planHash
  ) {
    invalid("qualified artifact requires exactly one matching holdout event")
  }

  const completedPhases = ["exploratory", "validation", "confirmatory"] as const
  const terminals = completedPhases.map((phase) =>
    attemptEvents.filter(
      (event) =>
        event.event === "completed" &&
        event.phase === phase &&
        event.planId === plan.planId &&
        event.planHash === plan.planHash &&
        event.candidateId === candidate.algorithmId &&
        event.policyId === policy.policyId &&
        event.policyHash === policy.policyHash &&
        event.codeHash === codeHash &&
        event.configHash === configHash &&
        event.result?.ok === true,
    ),
  )
  if (terminals.some((events) => events.length !== 1)) {
    invalid("qualified artifact has missing or ambiguous durable phase evidence")
  }
  const confirmatory = terminals[2]![0]!
  if (!confirmatory.result?.ok) {
    invalid("qualified artifact has no successful confirmatory result")
  }
  const decision = qualifyCandidateV1({
    candidateId: candidate.algorithmId,
    results: confirmatory.result.results,
    qualification: {
      policy,
      context: {
        schema: "finny.qualification_context",
        version: 1,
        planId: plan.planId,
        planHash: plan.planHash,
        phase: "confirmatory",
        holdoutOpenEvents: holdoutEvents,
        durableSelectionBudget: plan.declaredSearchBudget,
        durableTrialCount: completedPhases.length,
        datasetEvidenceId: plan.datasetEvidence.datasetEvidenceId,
        datasetHash: plan.datasetEvidence.datasetHash,
        datasetQualification: plan.datasetEvidence.qualification,
        dataQualityMode: "strict",
      },
    },
  })
  if (!decision.ok || decision.recommendation.verdict !== "recommended_for_paper") {
    invalid("confirmatory evidence no longer qualifies the exact artifact")
  }
  const draft = {
    schemaVersion: 1 as const,
    sessionId: input.sessionId,
    algorithmId: candidate.algorithmId,
    algorithmVersion: candidate.version,
    algorithmName: candidate.name,
    language: candidate.language,
    code: candidate.code,
    config,
    codeHash,
    configHash,
    experimentPlanId: plan.planId,
    experimentPlanHash: plan.planHash,
    qualificationPolicyId: policy.policyId,
    qualificationPolicyHash: policy.policyHash,
    datasetEvidenceId: plan.datasetEvidence.datasetEvidenceId,
    datasetHash: plan.datasetEvidence.datasetHash,
    datasetManifestHash: plan.datasetEvidence.manifestHash,
    holdoutEventHash: holdoutEvents[0]!.eventHash,
    confirmatoryAttemptId: confirmatory.attemptId,
    confirmatoryResult: confirmatory.result,
    confirmatoryResultHash: qualificationHash(confirmatory.result),
    completedPhases,
    qualificationDecision: decision,
    qualificationDecisionHash: qualificationHash(decision),
  }
  return { ...draft, artifactEvidenceHash: qualificationHash(draft) }
}
