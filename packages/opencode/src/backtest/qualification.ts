import type { BacktestRunner } from "./runner"
import { evaluateBacktestQuality, type BacktestQuality } from "./evaluation"
import { composeBacktestVerdict, deriveWalkForwardVerdict } from "./verdict"
import { confirmatoryPolicyErrors, qualificationInputErrors, type QualificationInputV1 } from "./qualification-policy"
import type { RunRecommendation } from "./run-integrity-core"

export type QualificationBlockerCode =
  | "invalid_policy"
  | "wrong_phase"
  | "sealed_holdout_required"
  | "selection_budget_invalid"
  | "dataset_not_strict_qualified"
  | "data_quality_mode_research_only"
  | "attempt_interrupted"
  | "quality_gates_failed"

export interface QualificationBlockerV1 {
  schema: "finny.qualification_blocker"
  version: 1
  code: QualificationBlockerCode
  field: string
  message: string
  nextAllowedTransition: string
}

export type QualifyCandidateResultV1 =
  | {
      ok: true
      candidateId: string
      planId: string
      policyId: string
      quality: BacktestQuality
      recommendation: RunRecommendation
    }
  | {
      ok: false
      candidateId: string
      planId: string
      policyId: string
      quality: BacktestQuality
      recommendation: RunRecommendation
      blocker: QualificationBlockerV1
    }

type BlockerRule = {
  matches: (message: string) => boolean
  code: QualificationBlockerCode
  field: string
  nextAllowedTransition: string
}

const BLOCKER_RULES: readonly BlockerRule[] = [
  {
    matches: (message) => message.includes("policy"),
    code: "invalid_policy",
    field: "qualificationPolicy",
    nextAllowedTransition: "supply the exact immutable QualificationPolicyV1",
  },
  {
    matches: (message) => message.includes("phase"),
    code: "wrong_phase",
    field: "phase",
    nextAllowedTransition: "run the compiled confirmatory window",
  },
  {
    matches: (message) => message.includes("holdout"),
    code: "sealed_holdout_required",
    field: "holdoutOpenEvents",
    nextAllowedTransition: "record the single approved durable holdout-open event",
  },
  {
    matches: (message) => ["budget", "trial count", "selection limit"].some((token) => message.includes(token)),
    code: "selection_budget_invalid",
    field: "durableTrialCount",
    nextAllowedTransition: "reconcile the durable attempt ledger without replaying unchanged blockers",
  },
  {
    matches: (message) => message.includes("dataset qualification"),
    code: "dataset_not_strict_qualified",
    field: "datasetQualification",
    nextAllowedTransition: "obtain authoritative strict_qualified DatasetEvidence",
  },
  {
    matches: (message) => message.includes("data quality mode"),
    code: "data_quality_mode_research_only",
    field: "dataQualityMode",
    nextAllowedTransition: "rerun the compiled plan with dataQualityMode=strict",
  },
]

const DEFAULT_BLOCKER: Omit<QualificationBlockerV1, "schema" | "version" | "message"> = {
  code: "quality_gates_failed",
  field: "metrics",
  nextAllowedTransition: "address the reported gate; do not reopen the sealed holdout",
}

function blockerFor(message: string): QualificationBlockerV1 {
  const rule = BLOCKER_RULES.find((candidate) => candidate.matches(message)) ?? DEFAULT_BLOCKER
  return {
    schema: "finny.qualification_blocker",
    version: 1,
    message,
    code: rule.code,
    field: rule.field,
    nextAllowedTransition: rule.nextAllowedTransition,
  }
}

/** One deterministic controller boundary for evaluation and verdict projection. */
export function qualifyCandidateV1(input: {
  candidateId: string
  results: BacktestRunner.Results
  qualification: QualificationInputV1
}): QualifyCandidateResultV1 {
  const quality = evaluateBacktestQuality(input.results, input.qualification)
  const recommendation = composeBacktestVerdict({
    quality,
    walkForward: deriveWalkForwardVerdict(input.results.v2?.walk_forward),
    consistency: input.results.v2?.consistency,
    decay: input.results.v2?.alpha_decay,
  })
  const contractErrors = [
    ...confirmatoryPolicyErrors(input.qualification.policy),
    ...qualificationInputErrors(input.qualification),
  ]
  const failure = contractErrors[0] ?? quality.reasons[0] ?? recommendation.reasons[0]
  const common = {
    candidateId: input.candidateId,
    planId: input.qualification.context.planId,
    policyId: input.qualification.policy.policyId,
    quality,
    recommendation,
  }
  if (recommendation.verdict === "recommended_for_paper" && contractErrors.length === 0) return { ok: true, ...common }
  return { ok: false, ...common, blocker: blockerFor(failure ?? "qualification gates failed") }
}
