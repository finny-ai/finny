import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { normalizeSymbol } from "@/agent/request-identity"
import type { Algorithm } from "@/algorithm"
import type { BacktestRunner } from "@/backtest/runner"
import * as RunIntegrity from "@/backtest/run-integrity"
import { enforceRobustWorkflowVerdict } from "@/backtest/verdict"
import type { VerifiedDatasetRef } from "@/data/data-extractor-evidence"
import { experimentRunContext, sha256Text, type ExperimentRunContext } from "./experiment"
import { backtestIdentityHash } from "./state"
import { BuildWorkflowStore } from "./store"
import type {
  BacktestHashes,
  BuildWorkflowState,
  EvidenceKind,
  RequestIdentity,
  WorkflowEvent,
  WorkflowEventSource,
} from "./types"

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

export const activeWorkflowForSession = Effect.fn("BuildWorkflowLifecycle.activeForSession")(function* (
  sessionId: string,
) {
  return (yield* BuildWorkflowStore.listBySession(sessionId)).find(
    (state) => state.status === "active" || state.status === "blocked",
  )
})

export const transitionWorkflowIdentity = Effect.fn("BuildWorkflowLifecycle.transitionIdentity")(function* (input: {
  sessionId: string
  identity: RequestIdentity
  source: WorkflowEventSource
  reason: string
}) {
  const workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow) return undefined
  const type = workflow.identityStatus === "confirmed" ? ("identity.amended" as const) : ("identity.confirmed" as const)
  const event: WorkflowEvent =
    type === "identity.amended"
      ? {
          id: eventID("evt_identity_amended"),
          type,
          occurredAt: Date.now(),
          source: input.source,
          identity: input.identity,
          reason: input.reason,
        }
      : {
          id: eventID("evt_identity_confirmed"),
          type,
          occurredAt: Date.now(),
          source: input.source,
          identity: input.identity,
        }
  const result = yield* BuildWorkflowStore.append({
    workflowId: workflow.workflowId,
    expectedRevision: workflow.revision,
    event,
  })
  if (result.kind === "applied") return result.decision.state
  if (result.kind === "rejected" && result.decision.code === "identity_unchanged") return workflow
  const code = result.kind === "rejected" ? result.decision.code : result.kind
  return yield* Effect.fail(new Error(`workflow identity transition failed: ${code}`))
})

export const resumeWorkflowRun = Effect.fn("BuildWorkflowLifecycle.resume")(function* (input: {
  sessionId: string
  changedFingerprint: string
}) {
  const workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow) return yield* Effect.fail(new Error("No resumable Build workflow was found."))
  if (workflow.status !== "blocked" || workflow.blocker?.code !== "workflow_interrupted") {
    return yield* Effect.fail(new Error("Only a workflow blocked by interruption can resume with a token."))
  }
  const tokenBoundFingerprint = sha256Text(`${workflow.resumeToken}:${input.changedFingerprint}`)
  const result = yield* BuildWorkflowStore.append({
    workflowId: workflow.workflowId,
    expectedRevision: workflow.revision,
    event: {
      id: eventID("evt_workflow_resumed"),
      type: "workflow.resumed",
      occurredAt: Date.now(),
      source: { actor: "tool" },
      changedFingerprint: tokenBoundFingerprint,
    },
  })
  if (result.kind === "applied") return result.decision.state
  const code = result.kind === "rejected" ? result.decision.code : result.kind
  return yield* Effect.fail(new Error(`workflow resume failed: ${code}`))
})

export const recordWorkflowAttempt = Effect.fn("BuildWorkflowLifecycle.recordAttempt")(function* (input: {
  sessionId: string
  operation: string
  fingerprint: string
  idempotencyKey: string
  outcome: "accepted" | "rejected" | "blocked" | "failed"
  lifecycle?: "in_progress" | "terminal"
  blockerCode?: string
  requiredChanges?: string[]
  artifactIds?: string[]
  evidenceIds?: string[]
  trialIds?: string[]
}) {
  const workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow) return { allowed: true as const, workflow: undefined }
  const id = `attempt_${sha256Text(`${workflow.workflowId}:${input.idempotencyKey}`).slice(0, 32)}`
  yield* Effect.annotateCurrentSpan({
    "finny.workflow.run_id": workflow.workflowId,
    "finny.workflow.request_id": workflow.sessionId,
    "finny.workflow.request_version": workflow.requestVersion,
    "finny.workflow.prior_phase": workflow.phase,
    "finny.workflow.requested_operation": input.operation,
    "finny.workflow.attempt_outcome": input.outcome,
    "finny.workflow.blocker_code": input.blockerCode ?? "",
    "finny.workflow.retry_disposition":
      input.outcome === "blocked" || input.outcome === "rejected" ? "deny_unchanged" : "record",
    "finny.workflow.idempotency_key_hash": sha256Text(input.idempotencyKey),
    "finny.workflow.artifact_ids": (input.artifactIds ?? []).join(","),
    "finny.workflow.evidence_ids": (input.evidenceIds ?? []).join(","),
    "finny.workflow.trial_ids": (input.trialIds ?? []).join(","),
    "finny.workflow.resume_token_hash": sha256Text(workflow.resumeToken),
  })
  const result = yield* BuildWorkflowStore.append({
    workflowId: workflow.workflowId,
    expectedRevision: workflow.revision,
    event: {
      id: `evt_${id}`,
      type: "attempt.recorded",
      occurredAt: Date.now(),
      source: { actor: "tool" },
      attempt: {
        id,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        operation: input.operation,
        outcome: input.outcome,
        lifecycle: input.lifecycle ?? (input.outcome === "accepted" ? "in_progress" : "terminal"),
        blockerCode: input.blockerCode,
        requiredChanges: input.requiredChanges ?? [],
        requestVersion: workflow.requestVersion,
        artifactIds: input.artifactIds ?? [],
        evidenceIds: input.evidenceIds ?? [],
        trialIds: input.trialIds ?? [],
        createdAt: Date.now(),
      },
    },
  })
  if (result.kind === "applied") {
    return { allowed: true as const, disposition: "recorded" as const, workflow: result.decision.state }
  }
  if (result.kind === "idempotent_replay") {
    const terminalBlocker = [...result.state.attempts]
      .reverse()
      .find(
        (attempt) =>
          attempt.fingerprint === input.fingerprint &&
          attempt.lifecycle === "terminal" &&
          (attempt.outcome === "blocked" || attempt.outcome === "rejected" || attempt.outcome === "failed"),
      )
    if (terminalBlocker) {
      return {
        allowed: false as const,
        code: "unchanged_blocker_retry_denied",
        message: `Attempt ${terminalBlocker.id} already terminalized this fingerprint; change ${terminalBlocker.requiredChanges.join(", ") || "the fingerprinted inputs"}.`,
        workflow: result.state,
      }
    }
    return { allowed: true as const, disposition: "resumed" as const, workflow: result.state }
  }
  if (result.kind === "rejected") {
    return {
      allowed: false as const,
      code: result.decision.code,
      message: result.decision.message,
      workflow: result.decision.state,
    }
  }
  return {
    allowed: false as const,
    code: result.kind,
    message: `workflow attempt append failed: ${result.kind}`,
    workflow,
  }
})

export const finishWorkflowRun = Effect.fn("BuildWorkflowLifecycle.finishRun")(function* (input: {
  sessionId: string
  classification: "completed" | "failed" | "interrupted"
  reason?: string
}) {
  let workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow) return undefined
  // A normal assistant turn is only one checkpoint in a long-running Build
  // workflow. Background evidence delivery and subsequent synthetic turns can
  // continue after that turn ends, so an ordinary finish before qualification
  // must leave the durable WorkflowRun active. Real blockers/failures are
  // recorded explicitly by their tools and the non-completed classifications
  // below; qualified completion remains terminal.
  if (input.classification === "completed" && workflow.phase !== "qualified") {
    return workflow.status === "active" ? undefined : workflow.terminal
  }
  const occurredAt = Date.now()
  const terminalEvent: WorkflowEvent =
    input.classification === "completed"
      ? {
          id: eventID("evt_workflow_completed"),
          type: "workflow.completed",
          occurredAt,
          source: { actor: "system" },
        }
      : input.classification === "failed"
        ? {
            id: eventID("evt_workflow_failed"),
            type: "workflow.failed",
            occurredAt,
            source: { actor: "system" },
            reason: input.reason ?? "workflow execution failed",
          }
        : {
            id: eventID("evt_workflow_interrupted"),
            type: "workflow.blocked",
            occurredAt,
            source: { actor: "system" },
            blocker: {
              code: "workflow_interrupted",
              message: input.reason ?? "workflow execution was interrupted",
              fingerprint: `${workflow.requestVersion}:${workflow.revision}:${workflow.phase}`,
              requiredChanges: ["resume the workflow with the stable resume token"],
            },
          }
  let result = yield* BuildWorkflowStore.append({
    workflowId: workflow.workflowId,
    expectedRevision: workflow.revision,
    event: terminalEvent,
  })
  if (result.kind === "applied") return result.decision.state.terminal
  if (input.classification !== "completed" || result.kind !== "rejected") return workflow.terminal

  const blockerEvent: WorkflowEvent = {
    id: eventID("evt_workflow_incomplete"),
    type: "workflow.blocked",
    occurredAt: Date.now(),
    source: { actor: "system" },
    blocker: {
      code: result.decision.code,
      message: result.decision.message,
      fingerprint: `${workflow.requestVersion}:${workflow.revision}:${workflow.phase}`,
      requiredChanges:
        workflow.phase === "strict_blocked"
          ? ["fingerprinted strict blocker inputs"]
          : ["durable workflow phase", "required evidence or qualified strict result"],
    },
  }
  result = yield* BuildWorkflowStore.append({
    workflowId: workflow.workflowId,
    expectedRevision: workflow.revision,
    event: blockerEvent,
  })
  if (result.kind === "applied") return result.decision.state.terminal
  return workflow.terminal
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
      requirement.symbols.length === 0 || requirement.symbols.some((symbol) => normalizeSymbol(symbol) === actualSymbol)
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

/** Record every single-symbol dataset emitted for a request-bound universe. */
export const recordVerifiedMarketDataSet = Effect.fn("BuildWorkflowLifecycle.recordVerifiedMarketDataSet")(function* (
  input: {
    sessionId: string
    datasets: readonly VerifiedDatasetRef[]
  },
) {
  let workflow: BuildWorkflowState | undefined
  for (const dataset of input.datasets) {
    workflow = yield* recordVerifiedMarketData({ sessionId: input.sessionId, dataset })
  }
  return workflow
})

/** Bind a provenance-validated news result to every matching news requirement. */
export const recordVerifiedNewsEvidence = Effect.fn("BuildWorkflowLifecycle.recordVerifiedNewsEvidence")(function* (input: {
  sessionId: string
  sourceSessionId: string
  artifactText: string
  issues?: string[]
}) {
  let workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow) return undefined
  const artifactId = sha256Text(input.artifactText)
  for (const requirement of workflow.evidenceRequirements.filter((item) => item.kind === "news")) {
    const already = workflow.evidence.some(
      (item) =>
        item.requirementId === requirement.id &&
        item.status === "verified" &&
        item.artifactId === artifactId &&
        item.sourceSessionId === input.sourceSessionId,
    )
    if (already) continue
    workflow = yield* appendRequired(
      workflow.workflowId,
      {
        id: eventID("evt_evidence"),
        type: "evidence.recorded",
        occurredAt: Date.now(),
        source: { actor: "subagent" },
        evidence: {
          id: `${requirement.id}:${artifactId}`,
          requirementId: requirement.id,
          kind: "news",
          status: "verified",
          artifactId,
          sourceSessionId: input.sourceSessionId,
          verifiedAt: Date.now(),
          issues: input.issues ?? [],
        },
      },
      workflow.revision,
    )
  }
  return workflow
})

/** Bind a completed, request-scoped specialist result to its SEC or sentiment requirement. */
export const recordVerifiedSpecialistEvidence = Effect.fn(
  "BuildWorkflowLifecycle.recordVerifiedSpecialistEvidence",
)(function* (input: {
  sessionId: string
  sourceSessionId: string
  kind: Extract<EvidenceKind, "sec" | "sentiment">
  artifactText: string
  issues?: string[]
}) {
  let workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow) return undefined
  const artifactId = sha256Text(input.artifactText)
  for (const requirement of workflow.evidenceRequirements.filter((item) => item.kind === input.kind)) {
    const already = workflow.evidence.some(
      (item) =>
        item.requirementId === requirement.id &&
        item.status === "verified" &&
        item.artifactId === artifactId &&
        item.sourceSessionId === input.sourceSessionId,
    )
    if (already) continue
    workflow = yield* appendRequired(
      workflow.workflowId,
      {
        id: eventID("evt_evidence"),
        type: "evidence.recorded",
        occurredAt: Date.now(),
        source: { actor: "subagent" },
        evidence: {
          id: `${requirement.id}:${artifactId}`,
          requirementId: requirement.id,
          kind: input.kind,
          status: "verified",
          artifactId,
          sourceSessionId: input.sourceSessionId,
          verifiedAt: Date.now(),
          issues: input.issues ?? [],
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
            record.requirementId === requirement.id && record.kind === requirement.kind && record.status === "verified",
        ),
    )
    .map((item) => `${item.kind}:${item.reason}`)
}

export const freezeWorkflowResearch = Effect.fn("BuildWorkflowLifecycle.freezeResearch")(function* (
  workflow: BuildWorkflowState,
) {
  if (workflow.researchFreeze && workflow.phase !== "evidence_ready") return workflow
  return yield* appendRequired(
    workflow.workflowId,
    {
      id: eventID("evt_research_frozen"),
      type: "research.frozen",
      occurredAt: Date.now(),
      source: { actor: "tool" },
      freeze: {
        id: `freeze_${sha256Text(`${workflow.workflowId}:${workflow.requestVersion}:${workflow.revision}`).slice(0, 24)}`,
        requestVersion: workflow.requestVersion,
        evidenceIds: workflow.evidence
          .filter((item) => item.status === "verified")
          .map((item) => item.id)
          .sort(),
        createdAt: Date.now(),
      },
    },
    workflow.revision,
  )
})

export const bindWorkflowExperimentPlan = Effect.fn("BuildWorkflowLifecycle.bindExperimentPlan")(function* (
  workflow: BuildWorkflowState,
) {
  if (workflow.experimentPlan && workflow.phase !== "candidate_validated") return workflow
  if (!workflow.candidate)
    return yield* Effect.fail(new Error("workflow candidate is required for experiment planning"))
  const fingerprint = sha256Text(
    JSON.stringify({
      workflowId: workflow.workflowId,
      requestVersion: workflow.requestVersion,
      candidateId: workflow.candidate.algorithmId,
      strategyHash: workflow.candidate.strategyHash,
      configHash: workflow.candidate.configHash,
    }),
  )
  return yield* appendRequired(
    workflow.workflowId,
    {
      id: eventID("evt_experiment_plan"),
      type: "experiment.plan_bound",
      occurredAt: Date.now(),
      source: { actor: "tool" },
      plan: {
        id: `plan_${fingerprint.slice(0, 24)}`,
        requestVersion: workflow.requestVersion,
        candidateId: workflow.candidate.algorithmId,
        fingerprint,
        createdAt: Date.now(),
        kind: "exploratory",
      },
    },
    workflow.revision,
  )
})

/** Replace the exploratory placeholder with the exact immutable legal plan. */
export const bindWorkflowQualificationPlan = Effect.fn("BuildWorkflowLifecycle.bindQualificationPlan")(
  function* (input: {
    workflow: BuildWorkflowState
    plan: { planId: string; planHash: string; candidate: { candidateId: string } }
  }) {
    const { workflow, plan } = input
    if (
      workflow.experimentPlan?.kind === "qualification" &&
      workflow.experimentPlan.id === plan.planId &&
      workflow.experimentPlan.planHash === plan.planHash
    )
      return workflow
    const replacingBlockedExploratory =
      workflow.phase === "strict_blocked" && workflow.experimentPlan?.kind === "exploratory"
    if (workflow.phase !== "candidate_validated" && !replacingBlockedExploratory) {
      return yield* Effect.fail(
        new Error(
          `qualification plan cannot replace ${workflow.experimentPlan?.id ?? "no plan"} from phase ${workflow.phase}`,
        ),
      )
    }
    return yield* appendRequired(
      workflow.workflowId,
      {
        id: eventID("evt_qualification_plan"),
        type: "experiment.plan_bound",
        occurredAt: Date.now(),
        source: { actor: "tool" },
        plan: {
          id: plan.planId,
          requestVersion: workflow.requestVersion,
          candidateId: plan.candidate.candidateId,
          fingerprint: plan.planHash,
          createdAt: Date.now(),
          kind: "qualification",
          planHash: plan.planHash,
        },
      },
      workflow.revision,
    )
  },
)

export const ensureWorkflowCandidate = Effect.fn("BuildWorkflowLifecycle.ensureCandidate")(function* (input: {
  workflow: BuildWorkflowState
  algorithm: Algorithm.Info
  dataset: VerifiedDatasetRef
  interval: string
  start?: string
  end?: string
}) {
  let workflow = input.workflow
  if (workflow.phase === "evidence_ready") workflow = yield* freezeWorkflowResearch(workflow)
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
      new Error(
        `workflow evidence is not ready: ${pendingEvidenceRequirements(workflow).join(" | ") || workflow.stage}`,
      ),
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

export const startWorkflowBacktest = Effect.fn("BuildWorkflowLifecycle.startBacktest")(function* (
  workflow: BuildWorkflowState,
) {
  if (workflow.phase === "candidate_validated") workflow = yield* bindWorkflowExperimentPlan(workflow)
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

/**
 * Best-effort terminalization for exceptions thrown after backtest.started.
 * This keeps a transport, experiment-ledger, or snapshot failure from leaving
 * the session permanently stranded in strict_running.
 */
export const failActiveWorkflowBacktest = Effect.fn("BuildWorkflowLifecycle.failActiveBacktest")(function* (input: {
  sessionId: string
  reason: string
}) {
  const workflow = yield* activeWorkflowForSession(input.sessionId)
  if (!workflow || workflow.stage !== "backtest_running") return workflow
  return yield* failWorkflowBacktest({ workflowId: workflow.workflowId, reason: input.reason })
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
  const controllerVerdict = enforceRobustWorkflowVerdict({
    verdict: input.verdict,
    totalReturn: input.results.totalReturn,
    stitchedOosReturn: input.results.v2?.walk_forward?.stitched_oos_return,
    alpha: input.results.alpha,
  })
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
      verdict: controllerVerdict,
    },
  })
})
