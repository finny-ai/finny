import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import { readSpec, writeSpec } from "./experiment-store"
import { withExperimentLock } from "./experiment-lock"
import { EXPLORATORY_QUALIFICATION_POLICY_V1 } from "./qualification-policy"
import {
  ExperimentContractError,
  type BeginTrialInput,
  type ExperimentBoundaries,
  type ExperimentInput,
  type ExperimentPhase,
  type ExperimentQualityGates,
  type ExperimentSpec,
} from "./experiment-types"

type SpecDraft = Omit<ExperimentSpec, "specHash" | "createdAt">

interface MissionFacts {
  hypothesis?: string
  falsificationCriteria?: string
  universe?: string[]
  primaryMetric?: string
  riskConstraints?: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  const fields = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
  return `{${fields.join(",")}}`
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function normalizeHypothesis(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function validatedExperimentId(value: string): string {
  if (/^[a-zA-Z0-9._-]{8,120}$/.test(value)) return value
  throw new ExperimentContractError(
    "experimentId must be 8-120 characters using only letters, digits, dot, underscore, or hyphen",
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function parseConfig(config?: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(config ?? "{}"))
  } catch {
    return {}
  }
}

function factsFromMission(data: Record<string, unknown>): MissionFacts {
  const scope = asRecord(data.scope)
  const strategy = asRecord(data.strategy)
  const universe = Array.isArray(scope.universe) ? scope.universe.map(String) : undefined
  return {
    hypothesis: stringField(data, "hypothesis"),
    falsificationCriteria: stringField(data, "exit_conditions"),
    universe,
    primaryMetric: stringField(strategy, "success_metric"),
    riskConstraints: stringField(strategy, "risk_profile"),
  }
}

async function missionFacts(algorithmId: string): Promise<MissionFacts> {
  const file = path.join(finnyArtifactPath("algorithms"), algorithmId, "mission.md")
  try {
    const parsed = matter(await fs.readFile(file, "utf8"))
    return factsFromMission(asRecord(parsed.data))
  } catch {
    return {}
  }
}

export function exploratoryQualityGates(input?: Partial<ExperimentQualityGates>): ExperimentQualityGates {
  return {
    minDeflatedSharpe: input?.minDeflatedSharpe ?? EXPLORATORY_QUALIFICATION_POLICY_V1.minDeflatedSharpe,
    minProbabilisticSharpe:
      input?.minProbabilisticSharpe ?? EXPLORATORY_QUALIFICATION_POLICY_V1.minProbabilisticSharpe,
    minOosCoverage: input?.minOosCoverage ?? EXPLORATORY_QUALIFICATION_POLICY_V1.minOosCoverage,
    minTrades: input?.minTrades ?? EXPLORATORY_QUALIFICATION_POLICY_V1.minTrades,
    requireCostSensitivity:
      input?.requireCostSensitivity ?? EXPLORATORY_QUALIFICATION_POLICY_V1.requireCostSensitivity,
  }
}

function hypothesisFor(input: BeginTrialInput, mission: MissionFacts, config: Record<string, unknown>): string {
  return (
    input.experiment?.hypothesis?.trim() ||
    mission.hypothesis ||
    stringField(config, "economic_hypothesis") ||
    stringField(config, "hypothesis") ||
    `${stringField(config, "symbol") ?? "unknown"} ${input.interval} strategy`
  )
}

function textValue(values: Array<string | undefined>, fallback: string): string {
  return values.find((value) => value?.trim())?.trim() ?? fallback
}

function draftContractFields(
  input: BeginTrialInput,
  mission: MissionFacts,
  config: Record<string, unknown>,
  experiment: BeginTrialInput["experiment"],
  symbol: string,
  execution: unknown,
) {
  return {
    falsificationCriteria: textValue(
      [experiment?.falsificationCriteria, mission.falsificationCriteria],
      "Primary metric and risk constraints fail",
    ),
    universe: mission.universe ?? [symbol],
    interval: input.interval,
    // The runtime owns the immutable snapshot identity. User/model prose such
    // as "exact BTC window" is scientific context, not a data hash, and must
    // never become the value later compared with engine run_metadata.data_hash.
    dataSnapshot: "engine-data-hash-bound-at-completion",
    corporateActionPolicy: textValue(
      [experiment?.corporateActionPolicy, stringField(config, "corporate_action_policy")],
      "provider-adjusted",
    ),
    costs: textValue([experiment?.costs], canonical(execution)),
    featureTiming: textValue([experiment?.featureTiming], "previous completed bars; next-open execution"),
    executionSemantics: textValue(
      [experiment?.executionSemantics, stringField(config, "fill_model")],
      "strict engine profile",
    ),
    boundaries: experiment?.boundaries,
    permittedSearchSpace: textValue(
      [experiment?.permittedSearchSpace],
      "saved strategy/config versions in this experiment lineage",
    ),
    optimizationBudget: experiment?.optimizationBudget ?? 20,
    primaryMetric: textValue([experiment?.primaryMetric, mission.primaryMetric], "out-of-sample Sharpe"),
    riskConstraints: textValue(
      [experiment?.riskConstraints, mission.riskConstraints],
      "maximum drawdown and positive benchmark alpha",
    ),
    benchmark: textValue([experiment?.benchmark], `buy-and-hold ${symbol === "unknown" ? "same asset" : symbol}`),
    qualityGates: exploratoryQualityGates(experiment?.qualityGates),
    sealedHoldout: Boolean(experiment?.boundaries),
  }
}

function buildDraft(input: BeginTrialInput, mission: MissionFacts, config: Record<string, unknown>): SpecDraft {
  const experiment = input.experiment
  const hypothesis = hypothesisFor(input, mission, config)
  const hypothesisKey = normalizeHypothesis(hypothesis)
  const symbol = stringField(config, "symbol") ?? "unknown"
  const execution = config.execution ?? config.costs ?? {}
  const experimentId = validatedExperimentId(experiment?.experimentId ?? `exp-${sha256(hypothesisKey).slice(0, 24)}`)
  return {
    schemaVersion: 1,
    experimentId,
    version: 1,
    parentExperimentId: experiment?.parentExperimentId,
    hypothesis: hypothesis.trim(),
    hypothesisKey,
    ...draftContractFields(input, mission, config, experiment, symbol, execution),
  }
}

function immutableSpec(spec: SpecDraft | ExperimentSpec) {
  const { version: _version, specHash: _hash, createdAt: _created, ...immutable } = spec as ExperimentSpec
  return immutable
}

function assertFrozenSpec(existing: ExperimentSpec, draft: SpecDraft) {
  if (canonical(immutableSpec(existing)) === canonical(immutableSpec(draft))) return
  throw new ExperimentContractError(
    `ExperimentSpec ${draft.experimentId} is frozen and the requested contract differs. Create a new experimentId with parentExperimentId=${draft.experimentId} to record an explicit lineage change.`,
  )
}

async function assertValidParent(draft: SpecDraft) {
  const parentId = draft.parentExperimentId
  if (!parentId) return
  validatedExperimentId(parentId)
  if (parentId === draft.experimentId) throw new ExperimentContractError("an experiment cannot be its own parent")
  if (!(await readSpec({ experimentId: parentId })))
    throw new ExperimentContractError(`parent experiment ${parentId} does not exist`)
}

function orderedBoundaries(boundaries: ExperimentBoundaries) {
  return [boundaries.trainStart, boundaries.trainEnd, boundaries.validationEnd, boundaries.testEnd]
}

function hasStrictDateOrder(values: string[]) {
  return values.every((value, index) => index === 0 || values[index - 1] < value)
}

export function validateBoundaries(boundaries?: ExperimentBoundaries) {
  if (!boundaries) return
  const values = orderedBoundaries(boundaries)
  if (!values.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw new ExperimentContractError("experiment boundaries must use YYYY-MM-DD dates")
  }
  if (!hasStrictDateOrder(values)) {
    throw new ExperimentContractError(
      "experiment boundaries must satisfy trainStart < trainEnd < validationEnd < testEnd",
    )
  }
}

export async function resolveExperimentSpec(input: BeginTrialInput): Promise<ExperimentSpec> {
  const config = parseConfig(input.algorithm.config)
  const mission = await missionFacts(input.algorithm.algorithmId)
  const draft = buildDraft(input, mission, config)
  validateBoundaries(draft.boundaries)
  return withExperimentLock(draft.experimentId, async () => {
    const existing = await readSpec({ experimentId: draft.experimentId })
    if (existing) {
      assertFrozenSpec(existing, draft)
      return existing
    }
    await assertValidParent(draft)
    const spec = {
      ...draft,
      createdAt: new Date().toISOString(),
      specHash: sha256(canonical(immutableSpec(draft))),
    }
    await writeSpec(spec)
    return spec
  })
}

function requireBoundedDates(startDate?: string, endDate?: string): asserts startDate is string {
  if (!startDate || !endDate)
    throw new ExperimentContractError("a bounded experiment requires exact startDate and endDate")
}

function requireHoldoutApproval(input: BeginTrialInput) {
  const approval = input.experiment
  if (approval?.holdoutApproved !== true) {
    throw new ExperimentContractError(
      "confirmatory holdout access requires holdoutApproved: true and a non-empty approvalReason",
    )
  }
  if (!approval.approvalReason?.trim()) {
    throw new ExperimentContractError(
      "confirmatory holdout access requires holdoutApproved: true and a non-empty approvalReason",
    )
  }
}

function requireExactHoldoutWindow(input: BeginTrialInput, boundaries: ExperimentBoundaries) {
  if (input.startDate !== boundaries.validationEnd) {
    throw new ExperimentContractError("confirmatory trials must use the frozen holdout window exactly")
  }
  if (input.endDate !== boundaries.testEnd) {
    throw new ExperimentContractError("confirmatory trials must use the frozen holdout window exactly")
  }
}

function validateConfirmatory(input: BeginTrialInput, boundaries: ExperimentBoundaries) {
  requireHoldoutApproval(input)
  requireExactHoldoutWindow(input, boundaries)
}

function validateExploratory(input: BeginTrialInput, boundaries: ExperimentBoundaries) {
  if (input.endDate! <= boundaries.trainEnd) return
  throw new ExperimentContractError("exploratory trials cannot observe the validation or sealed test window")
}

function validateValidation(input: BeginTrialInput, boundaries: ExperimentBoundaries) {
  if (input.endDate! < boundaries.validationEnd) return
  throw new ExperimentContractError("validation trials cannot observe the sealed test window")
}

const phaseValidators: Record<ExperimentPhase, (input: BeginTrialInput, boundaries: ExperimentBoundaries) => void> = {
  exploratory: validateExploratory,
  validation: validateValidation,
  confirmatory: validateConfirmatory,
}

export function validatePhase(input: BeginTrialInput, spec: ExperimentSpec): ExperimentPhase {
  const phase = input.experiment?.phase ?? "exploratory"
  const boundaries = spec.boundaries
  if (!boundaries) {
    if (phase === "exploratory") return phase
    throw new ExperimentContractError(
      "validation and confirmatory trials require explicit train/validation/test boundaries",
    )
  }
  requireBoundedDates(input.startDate, input.endDate)
  if (input.startDate < boundaries.trainStart)
    throw new ExperimentContractError("trial starts before the frozen train window")
  phaseValidators[phase](input, boundaries)
  return phase
}
