import crypto from "node:crypto"
import { confirmatoryPolicyErrors, type QualificationPolicyV1 } from "./qualification-policy"

export const EXPERIMENT_PLAN_SCHEMA = "finny.experiment_plan" as const

export type DatasetQualification = "strict_qualified" | "research_only" | "unqualified"

export interface ExperimentPlanRequestV1 {
  requestId: string
  requestVersion: number
  requestHash: string
  interval: string
  requestedStart: string
  requestedEnd: string
}

export interface ExperimentPlanCandidateV1 {
  candidateId: string
  codeHash: string
  configHash: string
  warmupBars: number
  declaredSearchBudget: number
}

export interface AuthoritativeCalendarV1 {
  calendarId: string
  calendarVersion: string
  timezone: string
  scheduleHash: string
}

export interface AuthoritativeBarV1 {
  timestamp: string
  sessionId: string
  sessionOpen: string
  sessionClose: string
}

/** Compatibility seam for #176. Its authoritative evidence can implement this shape. */
export interface DatasetEvidenceForPlanV1 {
  datasetEvidenceId: string
  datasetHash: string
  manifestHash: string
  qualification: DatasetQualification
  actualStart: string
  actualEnd: string
  interval: string
  calendar: AuthoritativeCalendarV1
  orderedBars: readonly AuthoritativeBarV1[]
}

export interface ExperimentWindowV1 {
  start: string
  end: string
  bars: number
  sessions: number
  firstSessionId: string
  lastSessionId: string
}

/** Engine-neutral per-symbol schedule binding used by ExperimentPlanV2. */
export interface PlanSymbolBindingV2 {
  canonicalSymbol: string
  assetClass: "equity" | "crypto_spot"
  datasetEvidenceId: string
  datasetHash: string
  manifestHash: string
  scheduleHash: string
  actualStart: string
  actualEnd: string
}

/**
 * V2 plan for a LEAN runtime. Binds the exact runtime, strategy source tree,
 * adapter, execution profile, container image, and per-symbol evidence so a
 * plan can never be replayed against a different engine or data set.
 */
export interface ExperimentPlanV2 {
  schema: typeof EXPERIMENT_PLAN_SCHEMA
  version: 2
  planId: string
  planHash: string
  request: ExperimentPlanRequestV1
  candidate: ExperimentPlanCandidateV1
  runtime: {
    profileId: "lean_python" | "lean_csharp"
    profileHash: string
    sourceTreeHash: string
    adapterHash: string
    executionProfileHash: string
    imageDigest: string
    leanCommit: string
    leanConfigHash: string
  }
  datasets: PlanSymbolBindingV2[]
  datasetCompositeHash: string
  interval: string
  warmupBars: number
  declaredSearchBudget: number
  orderPolicyVersion: 1
  calendarPolicyVersion: string
  canonicalMetricsVersion: 1
  qualificationPolicyId: string
  qualificationPolicyHash: string
  sealedHoldoutPolicy: "single_approved_event"
  windows: {
    warmup: ExperimentWindowV1
    exploratory: ExperimentWindowV1
    validation: ExperimentWindowV1
    confirmatory: ExperimentWindowV1
  }
}

export interface CompileExperimentPlanV2Input {
  request: ExperimentPlanRequestV1
  candidate: ExperimentPlanCandidateV1
  runtime: ExperimentPlanV2["runtime"]
  datasets: PlanSymbolBindingV2[]
  interval: string
  warmupBars: number
  declaredSearchBudget: number
  calendarPolicyVersion: string
  qualificationPolicy: QualificationPolicyV1
  validationFraction?: number
  confirmatoryFraction?: number
  /** Optional derived phase windows; computed deterministically by the caller. */
  windows?: ExperimentPlanV2["windows"]
}

export class ExperimentPlanV2CompileError extends Error {
  constructor(
    readonly code: "invalid_input" | "unsupported_runtime" | "empty_universe" | "mixed_asset_classes" | "insufficient_bars",
    message: string,
  ) {
    super(message)
  }
}

export function planDatasetCompositeHash(datasets: readonly PlanSymbolBindingV2[]): string {
  return crypto
    .createHash("sha256")
    .update(
      stablePlanJson(
        datasets.map((d) => ({ symbol: d.canonicalSymbol, dataset: d.datasetHash, manifest: d.manifestHash })),
      ),
    )
    .digest("hex")
}

/**
 * Compile and verify a V2 plan. Mirrors the V1 invariant style: every hash is
 * recomputed from the canonical inputs so stored plans stay self-verifying.
 * Window placement is derived by the qualification runtime from the
 * authoritative per-symbol schedules and injected before persistence.
 */
export function compileExperimentPlanV2(input: CompileExperimentPlanV2Input): ExperimentPlanV2 {
  if (input.runtime.profileId !== "lean_python" && input.runtime.profileId !== "lean_csharp") {
    throw new ExperimentPlanV2CompileError(
      "unsupported_runtime",
      `runtime profile ${input.runtime.profileId} is not a LEAN runtime`,
    )
  }
  if (input.datasets.length === 0) {
    throw new ExperimentPlanV2CompileError("empty_universe", "a LEAN plan requires at least one strict dataset binding")
  }
  if (input.datasets.length > 20) {
    throw new ExperimentPlanV2CompileError(
      "invalid_input",
      `LEAN v1 universes are fixed at up to 20 symbols; received ${input.datasets.length}`,
    )
  }
  const firstClass = input.datasets[0]!.assetClass
  if (input.datasets.some((d) => d.assetClass !== firstClass)) {
    throw new ExperimentPlanV2CompileError(
      "mixed_asset_classes",
      "LEAN v1 plans may not mix equity and crypto portfolios",
    )
  }

  const datasetCompositeHash = planDatasetCompositeHash(input.datasets)
  const draft: Omit<ExperimentPlanV2, "planId" | "planHash"> = {
    schema: EXPERIMENT_PLAN_SCHEMA,
    version: 2,
    request: input.request,
    candidate: input.candidate,
    runtime: input.runtime,
    datasets: input.datasets,
    datasetCompositeHash,
    interval: input.interval,
    warmupBars: input.warmupBars,
    declaredSearchBudget: input.declaredSearchBudget,
    orderPolicyVersion: 1,
    calendarPolicyVersion: input.calendarPolicyVersion,
    canonicalMetricsVersion: 1,
    qualificationPolicyId: input.qualificationPolicy.policyId,
    qualificationPolicyHash: input.qualificationPolicy.policyHash,
    sealedHoldoutPolicy: "single_approved_event",
    windows:
      input.windows ?? {
        warmup: { start: "", end: "", bars: 0, sessions: 0, firstSessionId: "", lastSessionId: "" },
        exploratory: { start: "", end: "", bars: 0, sessions: 0, firstSessionId: "", lastSessionId: "" },
        validation: { start: "", end: "", bars: 0, sessions: 0, firstSessionId: "", lastSessionId: "" },
        confirmatory: { start: "", end: "", bars: 0, sessions: 0, firstSessionId: "", lastSessionId: "" },
      },
  }
  const hash = planHash(draft)
  return { ...draft, planId: `plan-${hash.slice(0, 24)}`, planHash: hash }
}

export function verifyExperimentPlanV2(plan: ExperimentPlanV2): string[] {
  const errors: string[] = []
  if (plan.schema !== EXPERIMENT_PLAN_SCHEMA || plan.version !== 2) return ["unsupported experiment plan schema"]
  if (plan.datasets.length === 0 || plan.datasets.length > 20) errors.push("universe must contain 1-20 symbols")
  const firstClass = plan.datasets[0]?.assetClass
  if (firstClass && plan.datasets.some((d) => d.assetClass !== firstClass)) errors.push("mixed asset classes are unsupported")
  if (plan.runtime.profileId !== "lean_python" && plan.runtime.profileId !== "lean_csharp") {
    errors.push("runtime profile must be lean_python or lean_csharp")
  }
  if (!/^[a-f0-9]{64}$/i.test(plan.datasetCompositeHash)) errors.push("dataset composite hash is invalid")
  if (!/^[a-f0-9]{64}$/i.test(plan.runtime.profileHash)) errors.push("runtime profile hash is invalid")
  if (!/^[a-f0-9]{64}$/i.test(plan.runtime.sourceTreeHash)) errors.push("source tree hash is invalid")
  if (!/^[a-f0-9]{64}$/i.test(plan.runtime.adapterHash)) errors.push("adapter hash is invalid")
  if (!/^[a-f0-9]{64}$/i.test(plan.runtime.executionProfileHash)) errors.push("execution profile hash is invalid")
  if (!/^[a-f0-9]{64}$/i.test(plan.runtime.leanConfigHash)) errors.push("lean config hash is invalid")
  if (!/^sha256:[a-f0-9]{64}$/i.test(plan.runtime.imageDigest)) errors.push("image digest must be a pinned sha256 digest")
  if (!/^[0-9a-f]{40}$/i.test(plan.runtime.leanCommit)) errors.push("lean commit must be a full 40-char SHA")
  if (plan.orderPolicyVersion !== 1) errors.push("order policy version must be 1")
  if (plan.canonicalMetricsVersion !== 1) errors.push("canonical metrics version must be 1")
  if (plan.warmupBars < 0 || !Number.isInteger(plan.warmupBars)) errors.push("warmupBars must be a non-negative integer")
  if (plan.declaredSearchBudget <= 0 || !Number.isInteger(plan.declaredSearchBudget)) {
    errors.push("declaredSearchBudget must be a positive integer")
  }
  return errors
}

export interface ExperimentPlanV1 {
  schema: typeof EXPERIMENT_PLAN_SCHEMA
  version: 1
  planId: string
  planHash: string
  request: ExperimentPlanRequestV1
  candidate: ExperimentPlanCandidateV1
  datasetEvidence: Omit<DatasetEvidenceForPlanV1, "orderedBars">
  barScheduleHash: string
  barCount: number
  warmupBars: number
  declaredSearchBudget: number
  qualificationPolicyId: string
  qualificationPolicyHash: string
  sealedHoldoutPolicy: "single_approved_event"
  windows: {
    warmup: ExperimentWindowV1
    exploratory: ExperimentWindowV1
    validation: ExperimentWindowV1
    confirmatory: ExperimentWindowV1
  }
}

export interface CompileExperimentPlanInput {
  request: ExperimentPlanRequestV1
  candidate: ExperimentPlanCandidateV1
  datasetEvidence: DatasetEvidenceForPlanV1
  warmupBars: number
  declaredSearchBudget: number
  qualificationPolicy: QualificationPolicyV1
  validationFraction?: number
  confirmatoryFraction?: number
}

export class ExperimentPlanCompileError extends Error {
  constructor(
    readonly code: "invalid_input" | "request_dataset_mismatch" | "insufficient_bars",
    message: string,
  ) {
    super(message)
  }
}

export function stablePlanJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stablePlanJson).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stablePlanJson(item)}`)
    .join(",")}}`
}

export function planHash(value: unknown): string {
  return crypto.createHash("sha256").update(stablePlanJson(value)).digest("hex")
}

function instant(value: string, field: string, endOfDate = false): number {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDate ? "23:59:59.999" : "00:00:00.000"}Z`
    : value
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed))
    throw new ExperimentPlanCompileError("invalid_input", `${field} is not an ISO timestamp`)
  return parsed
}

function requireIdentity(input: CompileExperimentPlanInput) {
  const evidence = input.datasetEvidence
  const required = [
    input.request.requestId,
    input.request.requestHash,
    input.candidate.candidateId,
    input.candidate.codeHash,
    input.candidate.configHash,
    evidence.datasetEvidenceId,
    evidence.datasetHash,
    evidence.manifestHash,
    evidence.calendar.calendarId,
    evidence.calendar.calendarVersion,
    evidence.calendar.timezone,
    input.qualificationPolicy.policyId,
    input.qualificationPolicy.policyHash,
  ]
  if (required.some((value) => !value)) {
    throw new ExperimentPlanCompileError("invalid_input", "request, dataset, and calendar identities are required")
  }
  const policyError = confirmatoryPolicyErrors(input.qualificationPolicy)[0]
  if (policyError) throw new ExperimentPlanCompileError("invalid_input", policyError)
}

function requirePositiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ExperimentPlanCompileError("invalid_input", `${field} must be a positive integer`)
  }
}

function requestBars(
  input: CompileExperimentPlanInput,
  bars: readonly AuthoritativeBarV1[],
): AuthoritativeBarV1[] {
  const start = instant(input.request.requestedStart, "requestedStart")
  const end = instant(input.request.requestedEnd, "requestedEnd", true)
  return bars.filter((bar) => {
    const timestamp = instant(bar.timestamp, "bar timestamp")
    return timestamp >= start && timestamp <= end
  })
}

function requireCompatibleEvidence(
  input: CompileExperimentPlanInput,
  filteredBars: readonly AuthoritativeBarV1[],
) {
  if (input.request.interval !== input.datasetEvidence.interval) {
    throw new ExperimentPlanCompileError("request_dataset_mismatch", "request and dataset intervals do not match")
  }
  const actualStart = instant(input.datasetEvidence.actualStart, "actualStart")
  const actualEnd = instant(input.datasetEvidence.actualEnd, "actualEnd", true)
  const requiredStart = /^\d{4}-\d{2}-\d{2}$/.test(input.request.requestedStart) && filteredBars.length > 0
    ? instant(filteredBars[0].timestamp, "first requested bar")
    : instant(input.request.requestedStart, "requestedStart")
  const requiredEnd = /^\d{4}-\d{2}-\d{2}$/.test(input.request.requestedEnd) && filteredBars.length > 0
    ? instant(filteredBars.at(-1)!.timestamp, "last requested bar")
    : instant(input.request.requestedEnd, "requestedEnd", true)
  if (actualStart > requiredStart || actualEnd < requiredEnd) {
    throw new ExperimentPlanCompileError(
      "request_dataset_mismatch",
      "dataset evidence does not cover the requested range",
    )
  }
}

function validatedBar(bar: AuthoritativeBarV1, index: number) {
  const timestamp = instant(bar.timestamp, `orderedBars[${index}].timestamp`)
  const sessionOpen = instant(bar.sessionOpen, `orderedBars[${index}].sessionOpen`)
  const sessionClose = instant(bar.sessionClose, `orderedBars[${index}].sessionClose`)
  const invalid = () => new ExperimentPlanCompileError("invalid_input", `orderedBars[${index}] is not a legal session bar`)
  if (!bar.sessionId) throw invalid()
  if (timestamp < sessionOpen) throw invalid()
  if (timestamp > sessionClose) throw invalid()
  return timestamp
}

function validateOrderedBars(evidence: DatasetEvidenceForPlanV1): AuthoritativeBarV1[] {
  const bars = [...evidence.orderedBars]
  if (!bars.length) throw new ExperimentPlanCompileError("insufficient_bars", "authoritative bar schedule is empty")
  const timestamps = bars.map(validatedBar)
  if (timestamps.some((value, index) => index > 0 && value <= timestamps[index - 1])) {
    throw new ExperimentPlanCompileError("invalid_input", "authoritative bars are not strictly ordered")
  }
  if (planHash(bars) !== evidence.calendar.scheduleHash) {
    throw new ExperimentPlanCompileError("request_dataset_mismatch", "authoritative calendar schedule hash mismatch")
  }
  return bars
}

function window(bars: AuthoritativeBarV1[], start: number, length: number): ExperimentWindowV1 {
  const selected = bars.slice(start, start + length)
  return {
    start: selected[0].timestamp,
    end: selected.at(-1)!.timestamp,
    bars: selected.length,
    sessions: new Set(selected.map((bar) => bar.sessionId)).size,
    firstSessionId: selected[0].sessionId,
    lastSessionId: selected.at(-1)!.sessionId,
  }
}

function phaseCounts(usable: number, validationFraction: number, confirmatoryFraction: number) {
  const validation = Math.floor(usable * validationFraction)
  const confirmatory = Math.floor(usable * confirmatoryFraction)
  return { exploratory: usable - validation - confirmatory, validation, confirmatory }
}

function fractions(input: CompileExperimentPlanInput) {
  const validation = input.validationFraction ?? 0.2
  const confirmatory = input.confirmatoryFraction ?? 0.2
  const invalid = () => new ExperimentPlanCompileError(
    "invalid_input",
    "validation and confirmatory fractions must be positive and leave at least 20% exploratory data",
  )
  if (validation <= 0) throw invalid()
  if (confirmatory <= 0) throw invalid()
  if (validation + confirmatory >= 0.8) throw invalid()
  return { validation, confirmatory }
}

export function compileExperimentPlanV1(input: CompileExperimentPlanInput): ExperimentPlanV1 {
  requireIdentity(input)
  requirePositiveInteger(input.warmupBars, "warmupBars")
  requirePositiveInteger(input.declaredSearchBudget, "declaredSearchBudget")
  requirePositiveInteger(input.candidate.warmupBars, "candidate.warmupBars")
  requirePositiveInteger(input.candidate.declaredSearchBudget, "candidate.declaredSearchBudget")
  const bars = requestBars(input, validateOrderedBars(input.datasetEvidence))
  requireCompatibleEvidence(input, bars)
  const split = fractions(input)
  const counts = phaseCounts(bars.length - input.warmupBars, split.validation, split.confirmatory)
  if (Math.min(counts.exploratory, counts.validation, counts.confirmatory) < 2) {
    throw new ExperimentPlanCompileError(
      "insufficient_bars",
      `requested range has ${bars.length} authoritative bars; warmup and all scientific phases require at least two bars`,
    )
  }
  const { orderedBars: _, ...evidenceBinding } = input.datasetEvidence
  const draft = {
    schema: EXPERIMENT_PLAN_SCHEMA,
    version: 1 as const,
    request: input.request,
    candidate: input.candidate,
    datasetEvidence: evidenceBinding,
    barScheduleHash: input.datasetEvidence.calendar.scheduleHash,
    barCount: bars.length,
    warmupBars: input.warmupBars,
    declaredSearchBudget: input.declaredSearchBudget,
    qualificationPolicyId: input.qualificationPolicy.policyId,
    qualificationPolicyHash: input.qualificationPolicy.policyHash,
    sealedHoldoutPolicy: "single_approved_event" as const,
    windows: {
      warmup: window(bars, 0, input.warmupBars),
      exploratory: window(bars, input.warmupBars, counts.exploratory),
      validation: window(bars, input.warmupBars + counts.exploratory, counts.validation),
      confirmatory: window(bars, input.warmupBars + counts.exploratory + counts.validation, counts.confirmatory),
    },
  }
  const hash = planHash(draft)
  return { ...draft, planId: `plan-${hash.slice(0, 24)}`, planHash: hash }
}

function identityErrors(plan: ExperimentPlanV1): string[] {
  const { planId, planHash: hash, ...draft } = plan
  if (planHash(draft) !== hash || planId !== `plan-${hash.slice(0, 24)}`) return ["experiment plan hash mismatch"]
  return []
}

function validWindow(item: ExperimentWindowV1) {
  const start = Date.parse(item?.start)
  const end = Date.parse(item?.end)
  const checks = [Boolean(item?.start), Boolean(item?.end), Number.isFinite(start), Number.isFinite(end), start <= end, item.bars > 0]
  return !checks.includes(false)
}

function windowErrors(plan: ExperimentPlanV1): string[] {
  const phases = [plan.windows.warmup, plan.windows.exploratory, plan.windows.validation, plan.windows.confirmatory]
  if (!phases.every(validWindow)) return ["experiment plan window is invalid"]
  const disjoint = phases.every((item, index) => index === 0 || Date.parse(phases[index - 1].end) < Date.parse(item.start))
  return disjoint ? [] : ["experiment plan windows overlap"]
}

function calendarBindingError(plan: ExperimentPlanV1) {
  const calendar = plan.datasetEvidence?.calendar
  const complete = [calendar?.calendarId, calendar?.calendarVersion, calendar?.timezone].every(Boolean)
  return complete ? undefined : "experiment plan calendar binding is incomplete"
}

function scheduleBindingError(plan: ExperimentPlanV1) {
  const calendar = plan.datasetEvidence?.calendar
  const checks = [/^[a-f0-9]{64}$/i.test(plan.barScheduleHash), plan.barScheduleHash === calendar?.scheduleHash]
  return checks.includes(false) ? "experiment plan calendar schedule binding is invalid" : undefined
}

function countBindingError(plan: ExperimentPlanV1) {
  const totalBars = Object.values(plan.windows).reduce((sum, item) => sum + item.bars, 0)
  const reconciled = [totalBars === plan.barCount, plan.warmupBars === plan.windows.warmup.bars]
  return reconciled.includes(false) ? "experiment plan bar counts do not reconcile" : undefined
}

function policyBindingError(plan: ExperimentPlanV1) {
  const complete = [Boolean(plan.qualificationPolicyId), /^[a-f0-9]{64}$/i.test(plan.qualificationPolicyHash)]
  return complete.includes(false) ? "experiment plan qualification policy binding is invalid" : undefined
}

function candidateBindingError(plan: ExperimentPlanV1) {
  const candidate = plan.candidate
  const identity = [
    Boolean(candidate?.candidateId),
    /^[a-f0-9]{64}$/i.test(candidate?.codeHash),
    /^[a-f0-9]{64}$/i.test(candidate?.configHash),
  ]
  const constraints = [candidate?.warmupBars === plan.warmupBars, candidate?.declaredSearchBudget === plan.declaredSearchBudget]
  return [...identity, ...constraints].includes(false) ? "experiment plan candidate binding is invalid" : undefined
}

export function candidateMatchesExperimentPlanV1(input: {
  plan: ExperimentPlanV1
  candidateId: string
  codeHash: string
  configHash: string
}) {
  return [
    input.plan.candidate.candidateId === input.candidateId,
    input.plan.candidate.codeHash === input.codeHash,
    input.plan.candidate.configHash === input.configHash,
  ].every(Boolean)
}

function bindingErrors(plan: ExperimentPlanV1): string[] {
  return [
    calendarBindingError(plan),
    scheduleBindingError(plan),
    countBindingError(plan),
    policyBindingError(plan),
    candidateBindingError(plan),
  ]
    .filter((error): error is string => Boolean(error))
}

export function verifyExperimentPlanV1(plan: ExperimentPlanV1): string[] {
  if (plan.schema !== EXPERIMENT_PLAN_SCHEMA || plan.version !== 1) return ["unsupported experiment plan schema"]
  return [...identityErrors(plan), ...bindingErrors(plan), ...windowErrors(plan)]
}
