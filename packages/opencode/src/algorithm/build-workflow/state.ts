import { createHash } from "node:crypto"
import { normalizeInterval, normalizeSymbol } from "@/agent/request-identity"
import {
  approvalScopeHash,
  grantApproval,
  makeApprovalChallenge,
  paperTradingApprovalScope,
  rejectApproval,
  requestApproval,
  unambiguousApprovalDecision,
} from "./state-approvals"
import {
  backtestIdentityHash,
  conceptIdFor,
  experimentReplayKey,
  experimentTrialSummary,
  makeExperimentAttempt,
} from "./state-identity"
import { transition } from "./state-transitions"
import {
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_RUN_VERSION,
  type BuildWorkflowState,
  type CreateBuildWorkflowInput,
  type EvidencePolicyInput,
  type EvidenceRequirement,
  type FactSource,
  type RequestJsonProjection,
  type RequestIdentity,
} from "./types"

// Pure domain controller. Prompts may describe this workflow, but only these
// transitions decide whether evidence, candidates, runs, and approvals advance.

export {
  approvalScopeHash,
  backtestIdentityHash,
  conceptIdFor,
  experimentReplayKey,
  experimentTrialSummary,
  grantApproval,
  makeApprovalChallenge,
  makeExperimentAttempt,
  paperTradingApprovalScope,
  rejectApproval,
  requestApproval,
  transition,
  unambiguousApprovalDecision,
}

export function workflowResumeToken(workflowId: string, requestVersion: number): string {
  return `wfr_${createHash("sha256").update(`${workflowId}:${requestVersion}`).digest("hex").slice(0, 32)}`
}

function legacyPhase(value: Record<string, any>) {
  if (value.status === "completed") return "terminal_complete" as const
  if (value.status === "blocked" && value.stage === "backtest_running") return "strict_blocked" as const
  if (value.stage === "paper_approved" || value.stage === "reviewable") return "qualified" as const
  if (value.stage === "backtest_running") return "strict_running" as const
  if (value.stage === "candidate_ready" || value.stage === "backtested") return "candidate_validated" as const
  if (value.stage === "evidence_ready") return "evidence_ready" as const
  return value.identity &&
    typeof value.identity === "object" &&
    (value.identity as RequestIdentity).symbols?.value?.length
    ? ("identity_confirmed" as const)
    : ("identity_proposed" as const)
}

/** Explicit, deterministic V1 -> WorkflowRunV2 import used by the durable store. */
export function migrateLegacyBuildWorkflowState(input: unknown, now = Date.now()): BuildWorkflowState | undefined {
  if (!input || typeof input !== "object") return undefined
  const legacy = input as Record<string, any>
  if (legacy.schemaVersion !== WORKFLOW_SCHEMA_VERSION || legacy.runVersion !== undefined) return undefined
  if (typeof legacy.workflowId !== "string" || typeof legacy.sessionId !== "string") return undefined
  const requestVersion = 1
  const identityStatus = legacy.identity?.symbols?.value?.length ? ("confirmed" as const) : ("proposed" as const)
  const phase = legacyPhase(legacy)
  const researchFreeze = ["candidate_validated", "experiment_planned", "strict_running", "strict_blocked", "qualified", "terminal_complete"].includes(phase)
    ? {
        id: `${legacy.workflowId}:legacy_research_freeze`,
        requestVersion,
        evidenceIds: (legacy.evidence ?? []).filter((item: any) => item.status === "verified").map((item: any) => item.id),
        createdAt: Number(legacy.updatedAt ?? now),
      }
    : undefined
  const experimentPlan = legacy.candidate && ["strict_running", "strict_blocked", "qualified", "terminal_complete"].includes(phase)
    ? {
        id: `${legacy.workflowId}:legacy_experiment_plan`,
        requestVersion,
        candidateId: legacy.candidate.algorithmId,
        fingerprint: workflowResumeToken(legacy.workflowId, requestVersion),
        createdAt: Number(legacy.updatedAt ?? now),
      }
    : undefined
  return {
    ...legacy,
    runVersion: WORKFLOW_RUN_VERSION,
    phase,
    identityStatus,
    requestVersion,
    attempts: [],
    invalidations: [],
    researchFreeze,
    experimentPlan,
    resumeToken: workflowResumeToken(legacy.workflowId, requestVersion),
    revision: Number(legacy.revision ?? 0) + 1,
    updatedAt: now,
  } as unknown as BuildWorkflowState
}

function normalizedSymbols(input: EvidencePolicyInput["identity"]): string[] {
  const symbols = input.symbols?.value ?? []
  return [
    ...new Set(symbols.map((symbol) => normalizeSymbol(symbol)).filter((symbol): symbol is string => !!symbol)),
  ].sort()
}

function marketDataRequirements(input: EvidencePolicyInput): EvidenceRequirement[] {
  const required = input.intent !== "research" || input.marketDataRequired === true
  if (!required) return []
  const symbols = normalizedSymbols(input.identity)
  if (symbols.length === 0) {
    return [
      {
        id: "market_data:request",
        kind: "market_data",
        required: true,
        symbols: [],
        reason: "A build or update requires verified historical market data for its bound request.",
      },
    ]
  }
  return symbols.map((symbol) => ({
    id: `market_data:${symbol}`,
    kind: "market_data" as const,
    required: true,
    symbols: [symbol],
    reason: `Verified historical market data is required for ${symbol}.`,
  }))
}

function optionalClaimRequirement(
  enabled: boolean | undefined,
  requirement: EvidenceRequirement,
): EvidenceRequirement[] {
  return enabled ? [requirement] : []
}

export function evidenceRequirementsFor(input: EvidencePolicyInput): EvidenceRequirement[] {
  const symbols = normalizedSymbols(input.identity)
  const requirements = [
    ...marketDataRequirements(input),
    ...optionalClaimRequirement(input.newsRequired, {
      id: "news:request",
      kind: "news",
      required: true,
      symbols,
      reason: "The strategy thesis makes a current-regime or catalyst claim that requires request-bound news.",
    }),
    ...optionalClaimRequirement(input.filingDependent, {
      id: "sec:request",
      kind: "sec",
      required: true,
      symbols,
      reason: "The request depends on filing-derived evidence.",
    }),
    ...optionalClaimRequirement(input.sentimentRequired, {
      id: "sentiment:request",
      kind: "sentiment",
      required: true,
      symbols,
      reason: "The user explicitly made sentiment evidence part of the strategy thesis.",
    }),
  ]
  return requirements.sort((a, b) => a.id.localeCompare(b.id))
}

export function createBuildWorkflow(input: CreateBuildWorkflowInput): BuildWorkflowState {
  const now = input.now ?? Date.now()
  const evidenceRequirements = evidenceRequirementsFor(input)
  const identityStatus = input.identityStatus ?? (input.identity.symbols?.value.length ? "confirmed" : "proposed")
  const phase = identityStatus === "confirmed" ? ("identity_confirmed" as const) : ("identity_proposed" as const)
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    runVersion: WORKFLOW_RUN_VERSION,
    workflowId: input.workflowId,
    sessionId: input.sessionId,
    workspaceSlug: input.workspaceSlug,
    intent: input.intent,
    stage:
      identityStatus === "proposed"
        ? "request_bound"
        : evidenceRequirements.length > 0
          ? "evidence_pending"
          : "request_bound",
    status: "active",
    phase,
    identityStatus,
    requestVersion: 1,
    revision: 0,
    identity: input.identity,
    evidenceRequirements,
    evidence: [],
    approvalChallenges: [],
    approvals: [],
    experimentAttempts: [],
    attempts: [],
    invalidations: [],
    resumeToken: input.resumeToken ?? workflowResumeToken(input.workflowId, 1),
    createdAt: now,
    updatedAt: now,
  }
}

function provenanceEntry(output: Record<string, FactSource>, key: string, source: FactSource | undefined) {
  if (source) output[key] = source
}

function assignSymbolFacts(values: Record<string, unknown>, symbols: string[]) {
  if (symbols.length === 1) values.requested_symbol = symbols[0]
  if (symbols.length > 1) values.requested_symbols = symbols
}

function assignOptionalValue(values: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined) return
  if (value === null) return
  if (value === "") return
  values[key] = value
}

function projectionFacts(state: BuildWorkflowState) {
  const symbols = state.identity.symbols?.value ?? []
  const values: Record<string, unknown> = {}
  assignSymbolFacts(values, symbols)
  assignOptionalValue(
    values,
    "requested_interval",
    state.identity.interval ? normalizeInterval(state.identity.interval.value) : undefined,
  )
  assignOptionalValue(values, "requested_asset_class", state.identity.assetClass?.value)
  assignOptionalValue(values, "requested_algorithm_name", state.identity.algorithmName?.value)
  assignOptionalValue(values, "requested_strategy_family", state.identity.strategyFamily?.value)
  if (state.identity.window) {
    values.requested_start = state.identity.window.value.start
    values.requested_end = state.identity.window.value.end
  }
  return { symbols, values }
}

function projectionProvenance(state: BuildWorkflowState, symbolCount: number) {
  const provenance: Record<string, FactSource> = {}
  provenanceEntry(
    provenance,
    symbolCount === 1 ? "requested_symbol" : "requested_symbols",
    state.identity.symbols?.source,
  )
  provenanceEntry(provenance, "requested_interval", state.identity.interval?.source)
  provenanceEntry(provenance, "requested_asset_class", state.identity.assetClass?.source)
  provenanceEntry(provenance, "requested_algorithm_name", state.identity.algorithmName?.source)
  provenanceEntry(provenance, "requested_strategy_family", state.identity.strategyFamily?.source)
  provenanceEntry(provenance, "requested_window", state.identity.window?.source)
  return provenance
}

export function requestJsonProjection(state: BuildWorkflowState): RequestJsonProjection {
  const { symbols, values } = projectionFacts(state)
  return {
    schema_version: 1,
    source_of_truth: "algorithm_build_workflow",
    workflow_id: state.workflowId,
    workflow_revision: state.revision,
    workflow_stage: state.stage,
    workflow_phase: state.phase,
    identity_status: state.identityStatus,
    request_version: state.requestVersion,
    resume_token: state.resumeToken,
    request_id: state.sessionId,
    ...values,
    provenance: projectionProvenance(state, symbols.length),
    updated: new Date(state.updatedAt).toISOString(),
  }
}

function hasStringFields(value: Partial<BuildWorkflowState>, keys: Array<keyof BuildWorkflowState>) {
  return keys.every((key) => typeof value[key] === "string")
}

function hasArrayFields(value: Partial<BuildWorkflowState>, keys: Array<keyof BuildWorkflowState>) {
  return keys.every((key) => Array.isArray(value[key]))
}

export function isBuildWorkflowState(input: unknown): input is BuildWorkflowState {
  if (!input || typeof input !== "object") return false
  const value = input as Partial<BuildWorkflowState>
  if (value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) return false
  if (value.runVersion !== WORKFLOW_RUN_VERSION) return false
  if (typeof value.revision !== "number") return false
  if (typeof value.requestVersion !== "number") return false
  if (typeof value.resumeToken !== "string") return false
  if (!hasStringFields(value, ["workflowId", "sessionId", "workspaceSlug"])) return false
  return hasArrayFields(value, [
    "evidenceRequirements",
    "evidence",
    "approvalChallenges",
    "approvals",
    "experimentAttempts",
    "attempts",
    "invalidations",
  ])
}

export * as BuildWorkflow from "./state"
