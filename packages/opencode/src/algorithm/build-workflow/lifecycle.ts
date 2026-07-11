import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { normalizeSymbol } from "@/agent/request-identity"
import type { Algorithm } from "@/algorithm"
import type { BacktestRunner } from "@/backtest/runner"
import * as RunIntegrity from "@/backtest/run-integrity"
import type { VerifiedDatasetRef } from "@/data/data-extractor-evidence"
import { experimentRunContext, sha256Text, type ExperimentRunContext } from "./experiment"
import { backtestIdentityHash } from "./state"
import { BuildWorkflowStore } from "./store"
import type { BacktestHashes, BuildWorkflowState, WorkflowEvent } from "./types"

function eventID(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function appendRequired(workflowId: string, event: WorkflowEvent, expectedRevision?: number) {
  return Effect.gen(function* () {
    const current = yield* BuildWorkflowStore.get(workflowId)
    if (!current) return yield* Effect.fail(new Error(`workflow ${workflowId} was not found`))
    const result = yield* BuildWorkflowStore.append({ workflowId, event, expectedRevision })
    if (result.kind === "applied") return result.decision.state
    const code = result.kind === "rejected" ? result.decision.code : result.kind
    return yield* Effect.fail(new Error(`workflow transition failed: ${code}`))
  })
}

export const activeWorkflowForSession = Effect.fn("BuildWorkflowLifecycle.activeForSession")(function* (sessionId: string) {
  return (yield* BuildWorkflowStore.listBySession(sessionId)).find(
    (state) => state.status === "active" || state.status === "blocked",
  )
})

/** Bind the exact verified data artifact to every matching market-data requirement. */
export const recordVerifiedMarketData = Effect.fn("BuildWorkflowLifecycle.recordVerifiedMarketData")(function* (input: {
  sessionId: string
  dataset: VerifiedDatasetRef
}) {
  let workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow) return undefined
  const actualSymbol = normalizeSymbol(input.dataset.identity.actualSymbol)
  for (const requirement of workflow.evidenceRequirements.filter((item) => item.kind === "market_data")) {
    const matches =
      requirement.symbols.length === 0 ||
      requirement.symbols.some((symbol) => normalizeSymbol(symbol) === actualSymbol)
    if (!matches) continue
    const already = workflow.evidence.some(
      (item) =>
        item.requirementId === requirement.id &&
        item.status === "verified" &&
        item.artifactId === input.dataset.manifestSha256,
    )
    if (already) continue
    workflow = yield* appendRequired(
      workflow.workflowId,
      {
        id: eventID("evt_evidence"),
        type: "evidence.recorded",
        occurredAt: Date.now(),
        source: { actor: "tool" },
        evidence: {
          id: `${requirement.id}:${input.dataset.manifestSha256}`,
          requirementId: requirement.id,
          kind: "market_data",
          status: "verified",
          artifactId: input.dataset.manifestSha256,
          runId: input.dataset.identity.runId,
          verifiedAt: Date.now(),
          issues: [],
        },
      },
      workflow.revision,
    )
  }
  return workflow
})

export function pendingEvidenceRequirements(state: BuildWorkflowState): string[] {
  return state.evidenceRequirements
    .filter(
      (requirement) =>
        requirement.required &&
        !state.evidence.some(
          (record) =>
            record.requirementId === requirement.id &&
            record.kind === requirement.kind &&
            record.status === "verified",
        ),
    )
    .map((item) => `${item.kind}:${item.reason}`)
}

export const ensureWorkflowCandidate = Effect.fn("BuildWorkflowLifecycle.ensureCandidate")(function* (input: {
  workflow: BuildWorkflowState
  algorithm: Algorithm.Info
  dataset: VerifiedDatasetRef
  interval: string
  start?: string
  end?: string
}) {
  let workflow = input.workflow
  let context = yield* Effect.tryPromise(() =>
    experimentRunContext({
      workflow,
      algorithm: input.algorithm,
      dataset: input.dataset,
      interval: input.interval,
      start: input.start,
      end: input.end,
    }),
  )
  if (
    workflow.candidate?.strategyHash === context.strategyHash &&
    workflow.candidate.configHash === context.savedConfigHash &&
    workflow.candidate.conceptId === context.conceptId
  ) {
    return { workflow, experiment: context }
  }
  if (workflow.candidate) {
    workflow = yield* appendRequired(
      workflow.workflowId,
      {
        id: eventID("evt_candidate_invalidated"),
        type: "candidate.invalidated",
        occurredAt: Date.now(),
        source: { actor: "tool" },
        reason: "A new code/config/concept tuple was saved.",
      },
      workflow.revision,
    )
    context = yield* Effect.tryPromise(() =>
      experimentRunContext({
        workflow,
        algorithm: input.algorithm,
        dataset: input.dataset,
        interval: input.interval,
        start: input.start,
        end: input.end,
      }),
    )
  }
  if (workflow.stage !== "evidence_ready") {
    return yield* Effect.fail(
      new Error(`workflow evidence is not ready: ${pendingEvidenceRequirements(workflow).join(" | ") || workflow.stage}`),
    )
  }
  workflow = yield* appendRequired(
    workflow.workflowId,
    {
      id: eventID("evt_candidate"),
      type: "candidate.saved",
      occurredAt: Date.now(),
      source: { actor: "tool" },
      candidate: {
        algorithmId: input.algorithm.algorithmId,
        name: input.algorithm.name,
        version: input.algorithm.version,
        strategyHash: context.strategyHash,
        configHash: context.savedConfigHash,
        conceptId: context.conceptId,
      },
    },
    workflow.revision,
  )
  return { workflow, experiment: { ...context, workflow } satisfies ExperimentRunContext }
})

export const startWorkflowBacktest = Effect.fn("BuildWorkflowLifecycle.startBacktest")(function* (workflow: BuildWorkflowState) {
  return yield* appendRequired(
    workflow.workflowId,
    {
      id: eventID("evt_backtest_started"),
      type: "backtest.started",
      occurredAt: Date.now(),
      source: { actor: "tool" },
    },
    workflow.revision,
  )
})

export const failWorkflowBacktest = Effect.fn("BuildWorkflowLifecycle.failBacktest")(function* (input: {
  workflowId: string
  reason: string
}) {
  return yield* appendRequired(input.workflowId, {
    id: eventID("evt_backtest_failed"),
    type: "backtest.failed",
    occurredAt: Date.now(),
    source: { actor: "tool" },
    reason: input.reason,
  })
})

interface StrictRunHashProjection {
  runId: string
  engineHash: string
  hashes: BacktestHashes
  identityHash: string
}

function compatibilityEngineHash(run: Record<string, unknown>, results: BacktestRunner.Results): string {
  if (typeof run.engineHash === "string" && run.engineHash.trim()) return run.engineHash
  // PR1 compatibility for legacy runner bundles. PR2 replaces this version
  // label digest with the materialized engine-tree hash before eligibility.
  return sha256Text(String(results.engineVersion ?? "engine_v2"))
}

function strictRunProjection(
  run: Record<string, unknown>,
  results: BacktestRunner.Results,
  experiment: ExperimentRunContext,
): StrictRunHashProjection | undefined {
  if (run.schema !== RunIntegrity.RUN_BUNDLE_SCHEMA || run.version !== 1) return undefined
  const identity = run.identity
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("strict run is missing its immutable identity")
  }
  const strictIdentity = identity as Record<string, any>
  const strictIdentityHash = typeof run.identityHash === "string" ? run.identityHash : ""
  if (
    !/^[a-f0-9]{64}$/.test(strictIdentityHash) ||
    RunIntegrity.sha256Text(RunIntegrity.stableStringify(strictIdentity)) !== strictIdentityHash
  ) {
    throw new Error("strict run identity hash is missing or non-canonical")
  }
  const runId = typeof run.runId === "string" ? run.runId : ""
  if (results.runId && results.runId !== runId) throw new Error("strict runId disagrees with the engine result")

  const required = [
    "strategyHash",
    "savedConfigHash",
    "effectiveConfigHash",
    "rawDataHash",
    "processedDataHash",
    "manifestHash",
    "engineTreeHash",
    "riskContractHash",
    "assetProfileHash",
    "executionProfileHash",
  ] as const
  for (const name of required) {
    if (typeof strictIdentity[name] !== "string" || !/^[a-f0-9]{64}$/.test(strictIdentity[name])) {
      throw new Error(`strict run identity is missing ${name}`)
    }
  }
  if (
    strictIdentity.strategyHash !== experiment.strategyHash ||
    strictIdentity.savedConfigHash !== experiment.savedConfigHash ||
    strictIdentity.rawDataHash !== experiment.datasetHash ||
    strictIdentity.manifestHash !== experiment.manifestHash
  ) {
    throw new Error("strict run identity disagrees with the controller candidate or verified dataset")
  }
  const documents = strictIdentity.documentHashes
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) {
    throw new Error("strict run identity is missing document hashes")
  }
  const hashes: BacktestHashes = {
    strategyHash: strictIdentity.strategyHash,
    savedConfigHash: strictIdentity.savedConfigHash,
    effectiveConfigHash: strictIdentity.effectiveConfigHash,
    dataHash: strictIdentity.rawDataHash,
    processedDataHash: strictIdentity.processedDataHash,
    manifestHash: strictIdentity.manifestHash,
    engineHash: strictIdentity.engineTreeHash,
    riskContractHash: strictIdentity.riskContractHash,
    assetProfileHash: strictIdentity.assetProfileHash,
    executionProfileHash: strictIdentity.executionProfileHash,
    missionHash: String((documents as Record<string, unknown>).mission ?? ""),
    preferencesHash: String((documents as Record<string, unknown>).preferences ?? ""),
    decisionsHash: String((documents as Record<string, unknown>).decisions ?? ""),
    reasoningHash: String((documents as Record<string, unknown>).reasoning ?? ""),
    windowHash: experiment.windowHash,
    strictDateWindowHash: RunIntegrity.sha256Text(RunIntegrity.stableStringify(strictIdentity.dateWindow)),
    strictSeedHash: RunIntegrity.sha256Text(String(strictIdentity.seed)),
    strictRunIdentityHash: strictIdentityHash,
  }
  for (const name of ["missionHash", "preferencesHash", "decisionsHash", "reasoningHash"] as const) {
    if (!/^[a-f0-9]{64}$/.test(hashes[name])) throw new Error(`strict run identity is missing ${name}`)
  }
  return {
    runId,
    engineHash: strictIdentity.engineTreeHash,
    hashes,
    identityHash: backtestIdentityHash(hashes),
  }
}
async function strictRunHashes(
  results: BacktestRunner.Results,
  experiment: ExperimentRunContext,
): Promise<StrictRunHashProjection> {
  let run: Record<string, unknown> = {}
  if (results.artifactDir) {
    try {
      run = JSON.parse(await fs.readFile(path.join(results.artifactDir, "run.json"), "utf8"))
    } catch {}
  }
  const strict = strictRunProjection(run, results, experiment)
  if (strict) return strict
  const runId = results.runId ?? String(run.runId ?? "")
  const engineHash = compatibilityEngineHash(run, results)
  const hashes: BacktestHashes = {
    strategyHash: experiment.strategyHash,
    savedConfigHash: experiment.savedConfigHash,
    effectiveConfigHash: String(run.configHash ?? experiment.savedConfigHash),
    dataHash: experiment.datasetHash,
    manifestHash: experiment.manifestHash,
    engineHash,
    windowHash: experiment.windowHash,
  }
  const optionalRunHashes: Record<string, unknown> = {
    assetSpecHash: run.assetSpecHash,
    runReportedStrategyHash: run.strategyHash,
    runReportedDataHash: run.dataHash,
  }
  for (const [name, value] of Object.entries(optionalRunHashes)) {
    if (typeof value === "string" && value.trim()) hashes[name] = value
  }
  return { runId, engineHash, hashes, identityHash: backtestIdentityHash(hashes) }
}

export const completeWorkflowBacktest = Effect.fn("BuildWorkflowLifecycle.completeBacktest")(function* (input: {
  workflow: BuildWorkflowState
  experiment: ExperimentRunContext
  results: BacktestRunner.Results
  verdict: "failed" | "research_only" | "candidate" | "recommended_for_paper"
}) {
  const hashes = yield* Effect.tryPromise(() => strictRunHashes(input.results, input.experiment))
  if (!hashes.runId) return yield* Effect.fail(new Error("strict backtest completed without a runId"))
  return yield* appendRequired(input.workflow.workflowId, {
    id: eventID("evt_backtest_completed"),
    type: "backtest.completed",
    occurredAt: Date.now(),
    source: { actor: "tool" },
    backtest: {
      runId: hashes.runId,
      strategyHash: input.experiment.strategyHash,
      configHash: input.experiment.savedConfigHash,
      dataHash: input.experiment.datasetHash,
      engineHash: hashes.engineHash,
      hashes: hashes.hashes,
      identityHash: hashes.identityHash,
      verdict: input.verdict,
    },
  })
})
