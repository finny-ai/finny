import crypto from "node:crypto"
import { normalizeInterval, normalizeSymbol } from "@/agent/request-identity"
import type {
  BacktestHashes,
  BuildWorkflowState,
  ConceptDefinition,
  ExperimentAttempt,
  ExperimentTrialSummary,
} from "./types"

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

export function backtestIdentityHash(hashes: BacktestHashes): string {
  return crypto.createHash("sha256").update(canonicalJson(hashes)).digest("hex")
}

function canonicalRule(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
}

export function conceptIdFor(input: ConceptDefinition): string {
  const identity = {
    symbol: normalizeSymbol(input.symbol) ?? canonicalRule(input.symbol),
    assetClass: canonicalRule(input.assetClass),
    interval: normalizeInterval(input.interval) ?? canonicalRule(input.interval),
    strategyFamily: canonicalRule(input.strategyFamily),
    direction: canonicalRule(input.direction),
    entryRules: canonicalRule(input.entryRules),
    exitRules: canonicalRule(input.exitRules),
  }
  return crypto.createHash("sha256").update(canonicalJson(identity)).digest("hex")
}

export function experimentReplayKey(input: {
  strategyHash: string
  savedConfigHash: string
  datasetHash: string
  windowHash: string
}): string {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        strategyHash: input.strategyHash,
        savedConfigHash: input.savedConfigHash,
        datasetHash: input.datasetHash,
        windowHash: input.windowHash,
      }),
    )
    .digest("hex")
}

export function makeExperimentAttempt(
  input: Omit<ExperimentAttempt, "replayKey"> & { replayKey?: string },
): ExperimentAttempt {
  return {
    ...input,
    replayKey:
      input.replayKey ??
      experimentReplayKey({
        strategyHash: input.strategyHash,
        savedConfigHash: input.savedConfigHash,
        datasetHash: input.datasetHash,
        windowHash: input.windowHash,
      }),
  }
}

function uniqueMetricAttempts(state: BuildWorkflowState, conceptId: string): ExperimentAttempt[] {
  const seen = new Set<string>()
  const attempts: ExperimentAttempt[] = []
  for (const attempt of state.experimentAttempts) {
    if (attempt.conceptId !== conceptId) continue
    if (attempt.outcome !== "metrics") continue
    if (seen.has(attempt.replayKey)) continue
    seen.add(attempt.replayKey)
    attempts.push(attempt)
  }
  return attempts
}

export function experimentTrialSummary(
  state: BuildWorkflowState,
  input: { conceptId: string; replayKey?: string; currentGridTrials?: number },
): ExperimentTrialSummary {
  const attempts = uniqueMetricAttempts(state, input.conceptId)
  const replay = input.replayKey ? attempts.find((attempt) => attempt.replayKey === input.replayKey) : undefined
  const priorUniqueTrials = attempts.reduce((total, attempt) => total + attempt.gridTrials, 0)
  const currentGridTrials = replay ? 0 : Math.max(0, input.currentGridTrials ?? 1)
  const totalDsrTrials = priorUniqueTrials + currentGridTrials
  return {
    experimentId: state.workflowId,
    conceptId: input.conceptId,
    priorUniqueTrials,
    currentGridTrials,
    totalDsrTrials: Math.max(1, totalDsrTrials),
    remainingTrials: Math.max(0, 5 - priorUniqueTrials),
    replayOfAttemptId: replay?.id,
    budgetExceeded: !replay && totalDsrTrials > 5,
  }
}
