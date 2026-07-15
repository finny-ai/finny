import crypto from "node:crypto"
import type { ExperimentPhase } from "./experiment-types"
import type { DatasetQualification } from "./experiment-plan"

export const QUALIFICATION_POLICY_SCHEMA = "finny.qualification_policy" as const
export const QUALIFICATION_CONTEXT_SCHEMA = "finny.qualification_context" as const

export interface QualificationPolicyV1 {
  schema: typeof QUALIFICATION_POLICY_SCHEMA
  version: 1
  policyId: string
  policyHash: string
  requiredPhase: "confirmatory"
  requireSealedHoldout: true
  maxSelectionTrials: number
  minTrades: number
  minEffectiveSampleSize: number
  minOosCoverage: number
  minWalkForwardFolds: number
  minDeflatedSharpe: number
  minProbabilisticSharpe: number
  requireCostSensitivity: boolean
  requireBenchmark: boolean
  requirePositiveAlpha: boolean
  maxDrawdown: number
  maxStressDrawdown: number
  requireRiskContract: boolean
  allowedDataQualification: readonly ["strict_qualified"]
  allowedDataQualityMode: "strict"
}

export interface QualificationContextV1 {
  schema: typeof QUALIFICATION_CONTEXT_SCHEMA
  version: 1
  planId: string
  planHash: string
  phase: ExperimentPhase
  holdoutOpenEvents: readonly HoldoutOpenEventV1[]
  durableSelectionBudget: number
  durableTrialCount: number
  datasetEvidenceId: string
  datasetHash: string
  datasetQualification: DatasetQualification
  dataQualityMode: "strict" | "repair_outliers"
}

export interface HoldoutOpenEventV1 {
  schema: "finny.holdout_open_event"
  version: 1
  eventId: string
  eventHash: string
  ordinal: 1
  planId: string
  planHash: string
  approvalHash: string
  openedAt: string
}

export interface QualificationInputV1 {
  policy: QualificationPolicyV1
  context: QualificationContextV1
}

interface ContractCheck {
  valid: boolean
  error: string
}

function failedChecks(checks: readonly ContractCheck[]): string[] {
  return checks.filter((check) => !check.valid).map((check) => check.error)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`
}

export function qualificationHash(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value)).digest("hex")
}

export function makeQualificationPolicyV1(
  overrides: Partial<Omit<QualificationPolicyV1, "schema" | "version" | "policyId" | "policyHash">> = {},
): QualificationPolicyV1 {
  const draft = {
    schema: QUALIFICATION_POLICY_SCHEMA,
    version: 1 as const,
    requiredPhase: "confirmatory" as const,
    requireSealedHoldout: true as const,
    maxSelectionTrials: 20,
    minTrades: 30,
    minEffectiveSampleSize: 30,
    minOosCoverage: 0.95,
    minWalkForwardFolds: 5,
    minDeflatedSharpe: 0.95,
    minProbabilisticSharpe: 0.95,
    requireCostSensitivity: true,
    requireBenchmark: true,
    requirePositiveAlpha: true,
    maxDrawdown: 0.15,
    maxStressDrawdown: 0.5,
    requireRiskContract: true,
    allowedDataQualification: ["strict_qualified"] as const,
    allowedDataQualityMode: "strict" as const,
    ...overrides,
  }
  const policyHash = qualificationHash(draft)
  return { ...draft, policyId: `qualification-v1-${policyHash.slice(0, 16)}`, policyHash }
}

export const DEFAULT_QUALIFICATION_POLICY_V1 = Object.freeze(makeQualificationPolicyV1())

export function makeHoldoutOpenEventV1(input: {
  planId: string
  planHash: string
  approvalHash: string
  openedAt: string
}): HoldoutOpenEventV1 {
  const draft = {
    schema: "finny.holdout_open_event" as const,
    version: 1 as const,
    ordinal: 1 as const,
    ...input,
  }
  const eventHash = qualificationHash(draft)
  return { ...draft, eventId: `holdout-${eventHash.slice(0, 24)}`, eventHash }
}

export function verifyQualificationPolicyV1(policy: QualificationPolicyV1 | null | undefined): string[] {
  if (!policy || typeof policy !== "object") return ["qualification policy is missing"]
  const { policyId, policyHash, ...draft } = policy
  return failedChecks([
    {
      valid: [policy.schema === QUALIFICATION_POLICY_SCHEMA, policy.version === 1].every(Boolean),
      error: "unsupported qualification policy schema",
    },
    {
      valid: [qualificationHash(draft) === policyHash, policyId === `qualification-v1-${policyHash.slice(0, 16)}`].every(Boolean),
      error: "qualification policy hash mismatch",
    },
  ])
}

export function researchQualificationContext(
  input: {
    dataQualityMode?: "strict" | "repair_outliers"
    phase?: ExperimentPhase
    planId?: string
    planHash?: string
  } = {},
): QualificationContextV1 {
  return {
    schema: QUALIFICATION_CONTEXT_SCHEMA,
    version: 1,
    planId: input.planId ?? "legacy-uncompiled-plan",
    planHash: input.planHash ?? qualificationHash("legacy-uncompiled-plan"),
    phase: input.phase ?? "exploratory",
    holdoutOpenEvents: [],
    durableSelectionBudget: 0,
    durableTrialCount: 0,
    datasetEvidenceId: "legacy-unqualified-evidence",
    datasetHash: "legacy-unqualified-evidence",
    datasetQualification: "unqualified",
    dataQualityMode: input.dataQualityMode ?? "strict",
  }
}

export function qualificationInputForResearch(
  input: Parameters<typeof researchQualificationContext>[0] = {},
): QualificationInputV1 {
  return { policy: DEFAULT_QUALIFICATION_POLICY_V1, context: researchQualificationContext(input) }
}

function contextIdentityErrors(context: QualificationContextV1): string[] {
  return failedChecks([
    { valid: [context?.schema === QUALIFICATION_CONTEXT_SCHEMA, context?.version === 1].every(Boolean), error: "qualification context is missing or invalid" },
    { valid: [Boolean(context?.planId), Boolean(context?.planHash)].every(Boolean), error: "qualification context is missing compiled experiment plan identity" },
    { valid: [Boolean(context?.datasetEvidenceId), Boolean(context?.datasetHash)].every(Boolean), error: "qualification context is missing dataset evidence identity" },
  ])
}

function holdoutIdentityError(context: QualificationContextV1, event: HoldoutOpenEventV1) {
  const { eventId, eventHash, ...draft } = event
  const identityMatches = [
    qualificationHash(draft) === eventHash,
    eventId === `holdout-${eventHash.slice(0, 24)}`,
  ]
  if (identityMatches.includes(false)) {
    return "sealed holdout open event hash mismatch"
  }
  const planMatches = [event.ordinal === 1, event.planId === context.planId, event.planHash === context.planHash]
  if (planMatches.includes(false)) {
    return "sealed holdout open event does not match the compiled plan"
  }
  return undefined
}

function holdoutEventErrors(context: QualificationContextV1): string[] {
  if (context.holdoutOpenEvents.length !== 1) return ["sealed holdout requires exactly one durable open event"]
  const event = context.holdoutOpenEvents[0]
  const identityError = holdoutIdentityError(context, event)
  if (identityError) return [identityError]
  return failedChecks([
    { valid: /^[a-f0-9]{64}$/i.test(event.approvalHash), error: "sealed holdout approval hash is invalid" },
    { valid: Number.isFinite(Date.parse(event.openedAt)), error: "sealed holdout open timestamp is invalid" },
  ])
}

function budgetErrors(context: QualificationContextV1, policy: QualificationPolicyV1): string[] {
  return failedChecks([
    {
      valid: [Number.isSafeInteger(context?.durableSelectionBudget), context?.durableSelectionBudget >= 1].every(Boolean),
      error: "durable selection budget is missing",
    },
    {
      valid: [Number.isSafeInteger(context?.durableTrialCount), context?.durableTrialCount >= 1].every(Boolean),
      error: "durable trial count is missing",
    },
    {
      valid: context?.durableTrialCount <= context?.durableSelectionBudget,
      error: "durable selection budget was exceeded",
    },
    {
      valid: context?.durableTrialCount <= policy.maxSelectionTrials,
      error: "qualification policy selection limit was exceeded",
    },
  ])
}

function promotabilityErrors(context: QualificationContextV1, policy: QualificationPolicyV1): string[] {
  return failedChecks([
    { valid: context?.phase === policy.requiredPhase, error: `experiment phase is ${context?.phase ?? "missing"}, not ${policy.requiredPhase}` },
    { valid: context?.datasetQualification === "strict_qualified", error: `dataset qualification ${context?.datasetQualification ?? "missing"} is not promotable` },
    { valid: context?.dataQualityMode === policy.allowedDataQualityMode, error: `data quality mode ${context?.dataQualityMode ?? "missing"} is research-only` },
  ])
}

export function qualificationInputErrors(input: QualificationInputV1): string[] {
  if (!input || typeof input !== "object") return ["qualification policy and context are missing"]
  const context = input.context
  return [
    ...verifyQualificationPolicyV1(input.policy),
    ...contextIdentityErrors(context),
    ...promotabilityErrors(context, input.policy),
    ...holdoutEventErrors(context),
    ...budgetErrors(context, input.policy),
  ]
}
