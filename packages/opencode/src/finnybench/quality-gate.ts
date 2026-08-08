import crypto from "node:crypto"

export type QualityEvidenceClass = "synthetic_pinned" | "provider_backed_pinned"
export type QualityMetricName =
  | "median_excess_sharpe"
  | "share_beating_buy_hold"
  | "share_exploratory_gate"
  | "median_trade_count"
export type QualityGateStatus = "pass" | "warning" | "failure"

export interface QualityObservation {
  schema: "finnybench.quality-observation.v1"
  task_id: string
  provider: string
  model: string
  repeat: number
  pins: {
    task_sha256: string
    data_snapshot_sha256: string
    provider_config_sha256: string
  }
  evidence_class: QualityEvidenceClass
  strategy: {
    sharpe: number
    total_return: number
    exploratory_gate_passed: boolean
    closed_trades: number
  }
  benchmark: {
    sharpe: number
    total_return: number
  }
  promotion_eligible: false
}

export interface QualityGateConfig {
  schema: "finnybench.quality-gate.v1"
  suite_id: string
  minimum_observations: number
  thresholds: Record<QualityMetricName, { warning_delta: number; failure_delta: number }>
}

export interface QualityAggregates {
  observations: number
  median_excess_sharpe: number
  share_beating_buy_hold: number
  share_exploratory_gate: number
  median_trade_count: number
}

export interface QualityMetricResult {
  metric: QualityMetricName
  baseline: number
  candidate: number
  delta: number
  warning_delta: number
  failure_delta: number
  status: QualityGateStatus
}

export interface QualityGateReport {
  schema: "finnybench.quality-report.v1"
  suite_id: string
  evidence_class: QualityEvidenceClass | "mixed"
  baseline_fingerprint: string
  candidate_fingerprint: string
  baseline: QualityAggregates
  candidate: QualityAggregates
  metrics: QualityMetricResult[]
  errors: string[]
  status: QualityGateStatus
  interpretation: "benchmark_evidence_only"
  promotion_eligible: false
}

const sha256Pattern = /^[a-f0-9]{64}$/
const metricNames: QualityMetricName[] = [
  "median_excess_sharpe",
  "share_beating_buy_hold",
  "share_exploratory_gate",
  "median_trade_count",
]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function pinsValid(value: unknown): value is QualityObservation["pins"] {
  if (!record(value)) return false
  return [value.task_sha256, value.data_snapshot_sha256, value.provider_config_sha256].every(
    (item) => typeof item === "string" && sha256Pattern.test(item),
  )
}

export function isQualityObservation(value: unknown): value is QualityObservation {
  if (!record(value) || value.schema !== "finnybench.quality-observation.v1") return false
  if (!record(value.strategy) || !record(value.benchmark)) return false
  return [
    typeof value.task_id === "string" && value.task_id.length > 0,
    typeof value.provider === "string" && value.provider.length > 0,
    typeof value.model === "string" && value.model.length > 0,
    Number.isInteger(value.repeat) && Number(value.repeat) >= 0,
    pinsValid(value.pins),
    value.evidence_class === "synthetic_pinned" || value.evidence_class === "provider_backed_pinned",
    finite(value.strategy.sharpe),
    finite(value.strategy.total_return),
    typeof value.strategy.exploratory_gate_passed === "boolean",
    Number.isInteger(value.strategy.closed_trades) && Number(value.strategy.closed_trades) >= 0,
    finite(value.benchmark.sharpe),
    finite(value.benchmark.total_return),
    value.promotion_eligible === false,
  ].every(Boolean)
}

export function isQualityGateConfig(value: unknown): value is QualityGateConfig {
  if (!record(value) || value.schema !== "finnybench.quality-gate.v1" || !record(value.thresholds)) return false
  if (typeof value.suite_id !== "string" || !Number.isInteger(value.minimum_observations)) return false
  const thresholds = value.thresholds
  return metricNames.every((metric) => {
    const threshold = thresholds[metric]
    return (
      record(threshold) &&
      finite(threshold.warning_delta) &&
      finite(threshold.failure_delta) &&
      threshold.failure_delta < threshold.warning_delta &&
      threshold.warning_delta <= 0
    )
  })
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle]
}

function rounded(value: number): number {
  return Number(value.toFixed(12))
}

export function qualityAggregates(observations: QualityObservation[]): QualityAggregates {
  if (observations.length === 0) throw new Error("quality aggregates require at least one observation")
  const excessSharpes = observations.map((item) => item.strategy.sharpe - item.benchmark.sharpe)
  const beating = observations.filter((item) => item.strategy.total_return > item.benchmark.total_return).length
  const clearing = observations.filter((item) => item.strategy.exploratory_gate_passed).length
  return {
    observations: observations.length,
    median_excess_sharpe: rounded(median(excessSharpes)),
    share_beating_buy_hold: rounded(beating / observations.length),
    share_exploratory_gate: rounded(clearing / observations.length),
    median_trade_count: rounded(median(observations.map((item) => item.strategy.closed_trades))),
  }
}

function cohortKey(observation: QualityObservation): string {
  return [observation.task_id, observation.provider, observation.model, observation.repeat].join(":")
}

function pinKey(observation: QualityObservation): string {
  return [
    observation.pins.task_sha256,
    observation.pins.data_snapshot_sha256,
    observation.pins.provider_config_sha256,
    observation.evidence_class,
  ].join(":")
}

function cohortErrors(
  baseline: QualityObservation[],
  candidate: QualityObservation[],
  minimumObservations: number,
): string[] {
  const errors: string[] = []
  const baselineClasses = new Set(baseline.map((item) => item.evidence_class))
  const candidateClasses = new Set(candidate.map((item) => item.evidence_class))
  if (baselineClasses.size > 1) errors.push("baseline mixes synthetic and provider-backed evidence")
  if (candidateClasses.size > 1) errors.push("candidate mixes synthetic and provider-backed evidence")
  if (baselineClasses.size === 1 && candidateClasses.size === 1 && [...baselineClasses][0] !== [...candidateClasses][0])
    errors.push("baseline and candidate evidence classes do not match")
  if (baseline.length < minimumObservations)
    errors.push(`baseline has ${baseline.length} observations; requires at least ${minimumObservations}`)
  if (candidate.length < minimumObservations)
    errors.push(`candidate has ${candidate.length} observations; requires at least ${minimumObservations}`)
  const baselineByKey = new Map<string, QualityObservation>()
  for (const observation of baseline) {
    const key = cohortKey(observation)
    if (baselineByKey.has(key)) errors.push(`baseline contains duplicate cohort key ${key}`)
    baselineByKey.set(key, observation)
  }
  const candidateByKey = new Map<string, QualityObservation>()
  for (const observation of candidate) {
    const key = cohortKey(observation)
    if (candidateByKey.has(key)) errors.push(`candidate contains duplicate cohort key ${key}`)
    candidateByKey.set(key, observation)
  }
  for (const [key, accepted] of baselineByKey) {
    const current = candidateByKey.get(key)
    if (!current) errors.push(`candidate is missing pinned cohort ${key}`)
    else if (pinKey(accepted) !== pinKey(current)) errors.push(`candidate pins changed for ${key}`)
  }
  for (const key of candidateByKey.keys()) {
    if (!baselineByKey.has(key)) errors.push(`candidate added unreviewed cohort ${key}`)
  }
  return errors
}

function canonicalObservations(observations: QualityObservation[]): string {
  return JSON.stringify([...observations].sort((left, right) => cohortKey(left).localeCompare(cohortKey(right))))
}

function fingerprint(observations: QualityObservation[]): string {
  return crypto.createHash("sha256").update(canonicalObservations(observations)).digest("hex")
}

function statusFor(delta: number, threshold: QualityGateConfig["thresholds"][QualityMetricName]): QualityGateStatus {
  if (delta <= threshold.failure_delta) return "failure"
  if (delta <= threshold.warning_delta) return "warning"
  return "pass"
}

function overallStatus(metrics: QualityMetricResult[], errors: string[]): QualityGateStatus {
  if (errors.length > 0 || metrics.some((metric) => metric.status === "failure")) return "failure"
  if (metrics.some((metric) => metric.status === "warning")) return "warning"
  return "pass"
}

export function evaluateQualityGate(input: {
  config: QualityGateConfig
  baseline: QualityObservation[]
  candidate: QualityObservation[]
}): QualityGateReport {
  const errors = cohortErrors(input.baseline, input.candidate, input.config.minimum_observations)
  const fallback: QualityAggregates = {
    observations: 0,
    median_excess_sharpe: 0,
    share_beating_buy_hold: 0,
    share_exploratory_gate: 0,
    median_trade_count: 0,
  }
  const baseline = input.baseline.length > 0 ? qualityAggregates(input.baseline) : fallback
  const candidate = input.candidate.length > 0 ? qualityAggregates(input.candidate) : fallback
  const metrics = metricNames.map((metric): QualityMetricResult => {
    const delta = rounded(candidate[metric] - baseline[metric])
    const threshold = input.config.thresholds[metric]
    return {
      metric,
      baseline: baseline[metric],
      candidate: candidate[metric],
      delta,
      warning_delta: threshold.warning_delta,
      failure_delta: threshold.failure_delta,
      status: statusFor(delta, threshold),
    }
  })
  const classes = new Set(input.candidate.map((item) => item.evidence_class))
  return {
    schema: "finnybench.quality-report.v1",
    suite_id: input.config.suite_id,
    evidence_class: classes.size === 1 ? [...classes][0] : "mixed",
    baseline_fingerprint: fingerprint(input.baseline),
    candidate_fingerprint: fingerprint(input.candidate),
    baseline,
    candidate,
    metrics,
    errors,
    status: overallStatus(metrics, errors),
    interpretation: "benchmark_evidence_only",
    promotion_eligible: false,
  }
}

function displayMetric(metric: QualityMetricName, value: number): string {
  if (metric === "share_beating_buy_hold" || metric === "share_exploratory_gate") return `${(value * 100).toFixed(1)}%`
  return value.toFixed(3)
}

export function qualityReportMarkdown(report: QualityGateReport): string {
  const lines = [
    `## FinnyBench quality regression: ${report.status.toUpperCase()}`,
    "",
    `Evidence: \`${report.evidence_class}\` · ${report.candidate.observations} pinned observations`,
    "",
    "| Metric | Baseline | Candidate | Delta | Status |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.metrics.map(
      (metric) =>
        `| ${metric.metric} | ${displayMetric(metric.metric, metric.baseline)} | ${displayMetric(metric.metric, metric.candidate)} | ${displayMetric(metric.metric, metric.delta)} | ${metric.status} |`,
    ),
  ]
  if (report.errors.length > 0) {
    lines.push("", "Cohort errors:", "", ...report.errors.map((error) => `- ${error}`))
  }
  lines.push(
    "",
    "> Benchmark evidence only. Synthetic or provider-backed benchmark output is not live alpha evidence, paper eligibility, or deployment approval.",
    "",
  )
  return lines.join("\n")
}
