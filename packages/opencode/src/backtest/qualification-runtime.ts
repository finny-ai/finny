import fs from "node:fs/promises"
import type { Algorithm } from "../algorithm"
import type { RequestSpec } from "../agent/request-spec"
import type { DatasetQualificationAttestationV1, VerifiedDatasetRef } from "../data/data-extractor-evidence"
import { resolveAssetSpec } from "./asset-spec"
import { planHash, type AuthoritativeBarV1, type CompileExperimentPlanInput } from "./experiment-plan"
import { qualificationHash, type QualificationPolicyV1 } from "./qualification-policy"

const ADAPTER_VERSION = "observed-csv-bars-v1"

type AttestedDataset = VerifiedDatasetRef & { qualificationAttestation?: DatasetQualificationAttestationV1 }
type CalendarContext = { calendar: string; timezone: string }

const CALENDAR_TIMEZONES: Readonly<Record<string, string>> = {
  US_FUTURES: "America/Chicago",
  US_EQUITIES: "America/New_York",
  US_OPTIONS: "America/New_York",
  FX_24_5: "America/New_York",
}

function algorithmConfig(candidate: Algorithm.Info): Record<string, any> {
  try {
    return JSON.parse(candidate.config ?? "{}") as Record<string, any>
  } catch {
    return {}
  }
}

function positiveInteger(input: { value: unknown; fallback: number }): number {
  const valid = [Number.isSafeInteger(input.value), Number(input.value) > 0].every(Boolean)
  return valid ? Number(input.value) : input.fallback
}

function timezoneFor(input: { calendar: string }): string {
  return CALENDAR_TIMEZONES[input.calendar] ?? "UTC"
}

function localParts(input: { timestamp: string; timezone: string }) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(input.timestamp))
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

function nextDate(input: { date: string }): string {
  const next = new Date(`${input.date}T12:00:00.000Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

function sessionId(input: { timestamp: string } & CalendarContext): string {
  const parts = localParts(input)
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const rollsAtSeventeen = ["US_FUTURES", "FX_24_5"].includes(input.calendar)
  if (!rollsAtSeventeen) return date
  return Number(parts.hour) >= 17 ? nextDate({ date }) : date
}

function timestampsFromCsv(input: { text: string }): string[] {
  const lines = input.text.split(/\r?\n/).filter((line) => line.trim())
  const header = lines[0]?.split(",").map((value) => value.trim().toLowerCase()) ?? []
  const timestampIndex = header.indexOf("timestamp")
  if (timestampIndex < 0) throw new Error("verified dataset CSV has no timestamp column")
  return lines.slice(1).map((line, index) => {
    const raw = line.split(",")[timestampIndex]?.trim().replace(/^"|"$/g, "")
    const parsed = Date.parse(raw)
    if (!Number.isFinite(parsed)) throw new Error(`verified dataset row ${index + 2} has an invalid timestamp`)
    return new Date(parsed).toISOString()
  })
}

function authoritativeBars(input: { timestamps: string[] } & CalendarContext): AuthoritativeBarV1[] {
  const grouped = Map.groupBy(input.timestamps, (timestamp) => sessionId({ ...input, timestamp }))
  return input.timestamps.map((timestamp) => {
    const id = sessionId({ ...input, timestamp })
    const session = grouped.get(id)!
    return { timestamp, sessionId: id, sessionOpen: session[0], sessionClose: session.at(-1)! }
  })
}

function requiredRequest(request: RequestSpec) {
  const missing = () => new Error("active RequestSpec must contain interval, requested_start, and requested_end")
  if (!request.requested_interval) throw missing()
  if (!request.requested_start) throw missing()
  if (!request.requested_end) throw missing()
  return {
    requestId: request.request_id,
    requestVersion: request.request_version,
    requestHash: request.content_hash,
    interval: request.requested_interval,
    requestedStart: request.requested_start,
    requestedEnd: request.requested_end,
  }
}

function qualificationBinding(dataset: VerifiedDatasetRef) {
  const attestation = (dataset as AttestedDataset).qualificationAttestation
  const research = { datasetEvidenceId: `dataset-${dataset.manifestSha256.slice(0, 24)}`, qualification: "research_only" as const }
  if (!attestation) return research
  const exact = [
    attestation.schema === "finny.dataset_qualification_attestation",
    attestation.version === 1,
    attestation.datasetHash === dataset.csvSha256,
    attestation.manifestHash === dataset.manifestSha256,
  ].every(Boolean)
  if (!exact) return research
  return { datasetEvidenceId: attestation.datasetEvidenceId, qualification: attestation.qualification }
}

/**
 * Runtime-owned adapter from immutable request/evidence bytes to a plan input.
 * The observed CSV timestamps are authoritative; the model supplies no dates.
 * Only runtime-validated strict evidence carries an attestation; absent or
 * mismatched attestations remain research-only.
 */
export async function compileInputFromActiveEvidence(input: {
  request: RequestSpec
  dataset: VerifiedDatasetRef
  candidate: Algorithm.Info
  policy: QualificationPolicyV1
}): Promise<CompileExperimentPlanInput> {
  const config = algorithmConfig(input.candidate)
  const asset = resolveAssetSpec(config, input.dataset.identity.actualSymbol)
  const timezone = timezoneFor({ calendar: asset.calendar })
  const orderedBars = authoritativeBars({
    timestamps: timestampsFromCsv({ text: await fs.readFile(input.dataset.csvPath, "utf8") }),
    calendar: asset.calendar,
    timezone,
  })
  const binding = qualificationBinding(input.dataset)
  const warmupBars = positiveInteger({ value: config.warmup_bars ?? config.warmupBars, fallback: 1 })
  const declaredSearchBudget = positiveInteger({
    value: config.declared_search_budget ?? config.declaredSearchBudget ?? config.optimization_budget,
    fallback: input.policy.maxSelectionTrials,
  })
  return {
    request: requiredRequest(input.request),
    candidate: {
      candidateId: input.candidate.algorithmId,
      codeHash: qualificationHash(input.candidate.code),
      configHash: qualificationHash(input.candidate.config ?? ""),
      warmupBars,
      declaredSearchBudget,
    },
    datasetEvidence: {
      datasetEvidenceId: binding.datasetEvidenceId,
      datasetHash: input.dataset.csvSha256,
      manifestHash: input.dataset.manifestSha256,
      qualification: binding.qualification,
      actualStart: input.dataset.identity.actualStart,
      actualEnd: input.dataset.identity.actualEnd,
      interval: input.dataset.identity.actualInterval,
      calendar: {
        calendarId: asset.calendar,
        calendarVersion: ADAPTER_VERSION,
        timezone,
        scheduleHash: planHash(orderedBars),
      },
      orderedBars,
    },
    warmupBars,
    declaredSearchBudget,
    qualificationPolicy: input.policy,
  }
}
