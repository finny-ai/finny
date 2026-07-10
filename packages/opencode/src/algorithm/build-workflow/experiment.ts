import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"
import { LocalAlgorithmStore } from "@/storage/local/algorithm-store"
import type { Algorithm } from "@/algorithm"
import type { VerifiedDatasetRef } from "@/data/data-extractor-evidence"
import {
  conceptIdFor,
  experimentReplayKey,
  experimentTrialSummary,
  makeExperimentAttempt,
} from "./state"
import type {
  BuildWorkflowState,
  ConceptDefinition,
  ExperimentAttempt,
  ExperimentAttemptOutcome,
  ExperimentTrialSummary,
} from "./types"

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function canonicalWindow(input: { start?: string; end?: string; requestedStart: string; requestedEnd: string }) {
  return JSON.stringify({
    start: input.start ?? input.requestedStart,
    end: input.end ?? input.requestedEnd,
  })
}

// @codescene(disable-all) Mission parsing keeps all concept fields together for deterministic hashing.
function missionFields(data: Record<string, any>): Partial<ConceptDefinition> {
  const strategy = data.strategy && typeof data.strategy === "object" ? data.strategy : {}
  const scope = data.scope && typeof data.scope === "object" ? data.scope : {}
  return {
    assetClass: typeof scope.asset_class === "string" ? scope.asset_class : undefined,
    interval: typeof strategy.bar_interval === "string" ? strategy.bar_interval : undefined,
    strategyFamily: typeof strategy.type === "string" ? strategy.type : undefined,
    direction: typeof strategy.direction === "string" ? strategy.direction : undefined,
    entryRules: typeof strategy.entry_signal === "string" ? strategy.entry_signal : undefined,
    exitRules: typeof data.exit_conditions === "string" ? data.exit_conditions : undefined,
  }
}

async function missionConcept(algorithm: Algorithm.Info): Promise<Partial<ConceptDefinition>> {
  try {
    const raw = await fs.readFile(path.join(LocalAlgorithmStore.directoryFor(algorithm.algorithmId), "mission.md"), "utf8")
    return missionFields(matter(raw).data as Record<string, any>)
  } catch {
    return {}
  }
}

function parsedConfig(algorithm: Algorithm.Info): Record<string, any> {
  try {
    return algorithm.config ? JSON.parse(algorithm.config) : {}
  } catch {
    return {}
  }
}

export interface ExperimentRunContext {
  workflow: BuildWorkflowState
  concept: ConceptDefinition
  conceptId: string
  replayKey: string
  strategyHash: string
  savedConfigHash: string
  datasetHash: string
  manifestHash: string
  windowHash: string
  trials: ExperimentTrialSummary
}

export async function experimentRunContext(input: {
  workflow: BuildWorkflowState
  algorithm: Algorithm.Info
  dataset: VerifiedDatasetRef
  interval: string
  start?: string
  end?: string
  currentGridTrials?: number
}): Promise<ExperimentRunContext> {
  const mission = await missionConcept(input.algorithm)
  const config = parsedConfig(input.algorithm)
  const symbol =
    input.workflow.identity.symbols?.value[0] ??
    (typeof config.symbol === "string" ? config.symbol : input.dataset.identity.actualSymbol)
  const concept: ConceptDefinition = {
    symbol,
    assetClass:
      mission.assetClass ?? input.workflow.identity.assetClass?.value ?? input.dataset.identity.actualAssetClass ?? "unknown",
    interval: mission.interval ?? input.workflow.identity.interval?.value ?? input.interval,
    strategyFamily: mission.strategyFamily ?? input.workflow.identity.strategyFamily?.value ?? "unspecified",
    direction: mission.direction ?? (typeof config.direction === "string" ? config.direction : "unspecified"),
    // Strict saves carry mission rules. The code fallback still excludes the
    // algorithm name and preserves a deterministic, fail-closed identity for
    // legacy imports that do not yet have structured mission fields.
    entryRules: mission.entryRules ?? `legacy-code:${sha256Text(input.algorithm.code)}`,
    exitRules: mission.exitRules ?? `legacy-code:${sha256Text(input.algorithm.code)}`,
  }
  const conceptId = conceptIdFor(concept)
  const strategyHash = sha256Text(input.algorithm.code)
  const savedConfigHash = sha256Text(input.algorithm.config ?? "")
  const datasetHash = input.dataset.csvSha256
  const manifestHash = input.dataset.manifestSha256
  const windowHash = sha256Text(
    canonicalWindow({
      start: input.start,
      end: input.end,
      requestedStart: input.dataset.identity.requestedStart,
      requestedEnd: input.dataset.identity.requestedEnd,
    }),
  )
  const replayKey = experimentReplayKey({ strategyHash, savedConfigHash, datasetHash, windowHash })
  return {
    workflow: input.workflow,
    concept,
    conceptId,
    replayKey,
    strategyHash,
    savedConfigHash,
    datasetHash,
    manifestHash,
    windowHash,
    trials: experimentTrialSummary(input.workflow, {
      conceptId,
      replayKey,
      currentGridTrials: input.currentGridTrials ?? 1,
    }),
  }
}

export function experimentAttemptForRun(input: {
  context: ExperimentRunContext
  id: string
  outcome: ExperimentAttemptOutcome
  runId?: string
  createdAt?: number
  gridTrials?: number
}): ExperimentAttempt {
  return makeExperimentAttempt({
    id: input.id,
    experimentId: input.context.workflow.workflowId,
    conceptId: input.context.conceptId,
    strategyHash: input.context.strategyHash,
    savedConfigHash: input.context.savedConfigHash,
    datasetHash: input.context.datasetHash,
    windowHash: input.context.windowHash,
    replayKey: input.context.replayKey,
    gridTrials: Math.max(1, input.gridTrials ?? 1),
    outcome: input.outcome,
    runId: input.runId,
    createdAt: input.createdAt ?? Date.now(),
  })
}
