import crypto from "node:crypto"
import fs from "node:fs/promises"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { z } from "zod"
import { Agent } from "../../src/agent/agent"
import {
  FUND_ACTION_TYPES,
  FUND_ACTION_POLICY,
  FUND_DRAFT_REVIEWERS,
  FUND_MANAGER_AGENT,
  FUND_RUNTIME_MODEL,
  FUND_SPECIALIST_AGENTS,
  effectiveFundRuntimePermission,
  fundDelegationError,
} from "../../src/agent/fund-policy"
import { Permission } from "../../src/permission"
import { FundCaseStore } from "../../src/fund/case-store"
import { MessageID, SessionID } from "../../src/session/schema"
import { TaskState } from "../../src/task/state"
import {
  FundActionDraftTool,
  FundActionProposalTool,
  FundSpecialistReportTool,
  type FundActionDraftInput,
  type FundActionProposalInput,
  type FundSpecialistReportInput,
} from "../../src/tool/fund-contracts"
import * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"

export const FUND_HARNESS_MODEL = `${FUND_RUNTIME_MODEL.providerID}/${FUND_RUNTIME_MODEL.modelID}` as const

export const FundHarnessStageName = z.enum([
  "event_bound",
  "context_verified",
  "specialists_completed",
  "decision_proposed",
  "approval_gated",
  "position_preserved",
])
export type FundHarnessStageName = z.infer<typeof FundHarnessStageName>

const OpaqueID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/)
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const EventType = z.enum([
  "order_filled",
  "order_cancelled",
  "regime_changed",
  "strategy_health_changed",
  "risk_limit_changed",
  "deployment_result",
  "scheduled_review",
  "operator_request",
])
const ActionType = z.enum(FUND_ACTION_TYPES)
const SpecialistAgent = z.enum(FUND_SPECIALIST_AGENTS)
const RiskTier = z.enum(["observation", "bounded_paper", "material_change"])
const SYNTHETIC_OFFLINE_EVIDENCE = "synthetic_offline" as const

export const FundHeadlessScenarioV1 = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("fund"),
    id: OpaqueID,
    model: z.literal(FUND_HARNESS_MODEL),
    event: z
      .object({
        eventId: OpaqueID,
        eventType: EventType,
        assetClass: z.enum(["equity", "crypto"]),
        strategyId: OpaqueID,
        strategyVersion: z.number().int().positive(),
        openPosition: z
          .object({
            positionId: OpaqueID,
            quantity: z.number().finite().positive(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    expected: z
      .object({
        action: ActionType,
        riskTier: RiskTier,
        specialists: z.array(SpecialistAgent).min(1).max(FUND_SPECIALIST_AGENTS.length),
        humanApprovalRequired: z.boolean(),
        preserveOpenPosition: z.boolean(),
      })
      .strict(),
    limits: z
      .object({
        specialists: z.number().int().positive().max(FUND_SPECIALIST_AGENTS.length),
        decisions: z.literal(1),
      })
      .strict(),
    requiredStages: z.array(FundHarnessStageName).min(1),
    forbidExecution: z.literal(true),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    if (new Set(scenario.expected.specialists).size !== scenario.expected.specialists.length) {
      ctx.addIssue({ code: "custom", path: ["expected", "specialists"], message: "must be unique" })
    }
    if (scenario.expected.specialists.length > scenario.limits.specialists) {
      ctx.addIssue({
        code: "custom",
        path: ["expected", "specialists"],
        message: "exceeds the specialist limit",
      })
    }
    if (new Set(scenario.requiredStages).size !== scenario.requiredStages.length) {
      ctx.addIssue({ code: "custom", path: ["requiredStages"], message: "must be unique" })
    }
    if (scenario.expected.preserveOpenPosition && !scenario.event.openPosition) {
      ctx.addIssue({
        code: "custom",
        path: ["event", "openPosition"],
        message: "is required when preserveOpenPosition is true",
      })
    }
    if (scenario.event.openPosition && !scenario.expected.preserveOpenPosition) {
      ctx.addIssue({
        code: "custom",
        path: ["expected", "preserveOpenPosition"],
        message: "must be true while the event has an existing open position",
      })
    }
    const advisoryOnly = scenario.expected.action === "no_change" || scenario.expected.action === "request_analysis"
    if (advisoryOnly && scenario.expected.riskTier !== "observation") {
      ctx.addIssue({
        code: "custom",
        path: ["expected", "riskTier"],
        message: "must be observation for an advisory-only result",
      })
    }
    if (!advisoryOnly && scenario.expected.riskTier === "observation") {
      ctx.addIssue({
        code: "custom",
        path: ["expected", "riskTier"],
        message: "must be bounded_paper or material_change for a state-change proposal",
      })
    }
    if (scenario.expected.riskTier === "material_change") {
      for (const required of ["fund_independent_validator", "fund_risk_sentinel"] as const) {
        if (scenario.expected.specialists.includes(required)) continue
        ctx.addIssue({
          code: "custom",
          path: ["expected", "specialists"],
          message: `${required} is required for a material change`,
        })
      }
      if (!scenario.expected.humanApprovalRequired) {
        ctx.addIssue({
          code: "custom",
          path: ["expected", "humanApprovalRequired"],
          message: "must be true for a material change",
        })
      }
    }
  })
export type FundHeadlessScenarioV1 = z.infer<typeof FundHeadlessScenarioV1>

const FundTraceEvent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("event_bound"),
      eventId: OpaqueID,
      eventType: EventType,
      strategyId: OpaqueID,
      strategyVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("context_verified"),
      portfolioSnapshotSha256: Sha256,
      marketSnapshotSha256: Sha256,
    })
    .strict(),
  z
    .object({
      type: z.literal("specialist_completed"),
      agent: SpecialistAgent,
      reportSha256: Sha256,
    })
    .strict(),
  z
    .object({
      type: z.literal("decision_proposed"),
      action: ActionType,
      riskTier: RiskTier,
      proposalSha256: Sha256,
      executionAuthorized: z.boolean(),
      openPositionPolicy: z.enum(["preserve_existing", "modify_existing"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("approval_gated"),
      required: z.boolean(),
      status: z.enum(["pending", "approved", "declined", "not_required"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("position_preserved"),
      positionId: OpaqueID,
      beforeQuantity: z.number().finite().positive(),
      afterQuantity: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("execution_attempted"),
      action: ActionType,
    })
    .strict(),
])

export const FundHeadlessTraceV1 = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    scenarioId: OpaqueID,
    model: z.string().min(1),
    provenance: z
      .object({
        evidenceMode: z.literal(SYNTHETIC_OFFLINE_EVIDENCE),
        fixture: z.literal("static_json"),
        providerBacked: z.literal(false),
        networkAccess: z.literal("disabled"),
      })
      .strict(),
    events: z.array(FundTraceEvent),
  })
  .strict()
export type FundHeadlessTraceV1 = z.infer<typeof FundHeadlessTraceV1>

export const FundHarnessViolation = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    evidence: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
export type FundHarnessViolation = z.infer<typeof FundHarnessViolation>

const FundRuntimePermissionCheckV1 = z
  .object({
    agent: z.enum([FUND_MANAGER_AGENT, ...FUND_SPECIALIST_AGENTS]),
    permission: z.string().min(1),
    pattern: z.string().min(1),
    expected: z.enum(["allow", "deny"]),
    observed: z.enum(["allow", "deny", "ask"]),
  })
  .strict()

const FundRuntimeToolCallV1 = z
  .object({
    agent: z.enum([FUND_MANAGER_AGENT, ...FUND_SPECIALIST_AGENTS]),
    tool: z.enum(["finny_fund_specialist_report", "finny_fund_action_draft", "finny_fund_action_propose"]),
    accepted: z.boolean(),
    outputSha256: Sha256,
  })
  .strict()

const FundRuntimeTaskV1 = z
  .object({
    agent: SpecialistAgent,
    states: z.tuple([z.literal("queued"), z.literal("running"), z.literal("completed")]),
    reportSha256: Sha256,
  })
  .strict()

export const FundRuntimeSessionProofV1 = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    evidenceMode: z.literal(SYNTHETIC_OFFLINE_EVIDENCE),
    runtime: z.literal("deterministic_local"),
    providerBacked: z.literal(false),
    networkAccess: z.literal("disabled"),
    taskStateStore: z.literal("ephemeral_sqlite"),
    managerAgent: z.literal(FUND_MANAGER_AGENT),
    model: z.literal(FUND_HARNESS_MODEL),
    permissionChecks: z.array(FundRuntimePermissionCheckV1).min(1),
    toolCalls: z.array(FundRuntimeToolCallV1).min(1),
    tasks: z.array(FundRuntimeTaskV1),
    proposal: z
      .object({
        action: ActionType,
        riskTier: RiskTier,
        proposalSha256: Sha256,
        executionAuthorized: z.literal(false),
        humanApprovalRequired: z.boolean(),
        gatewayReview: z.enum(["not_executable", "required"]),
        openPositionPolicy: z.literal("preserve_existing"),
      })
      .strict()
      .optional(),
    boundaryChecks: z
      .object({
        managerSpecialistReportRejected: z.boolean(),
        specialistActionProposalRejected: z.boolean(),
        specialistNestedDelegationRejected: z.boolean(),
        unregisteredDelegationRejected: z.boolean(),
        dangerousManagerPermissionsDenied: z.boolean(),
        dangerousSpecialistPermissionsDenied: z.boolean(),
      })
      .strict(),
    violations: z.array(FundHarnessViolation),
    semanticSha256: Sha256,
  })
  .strict()
export type FundRuntimeSessionProofV1 = z.infer<typeof FundRuntimeSessionProofV1>

export const FundRunManifestV1 = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("fund"),
    scenarioId: OpaqueID,
    status: z.enum(["synthetic_validated", "completed", "contract_failed"]),
    exitCode: z.union([z.literal(0), z.literal(2)]),
    model: z.string(),
    proofKind: z.enum(["synthetic_fixture", "deterministic_runtime"]),
    evidenceMode: z.literal(SYNTHETIC_OFFLINE_EVIDENCE),
    providerBacked: z.literal(false),
    networkAccess: z.literal("disabled"),
    paperEligible: z.literal(false),
    approvalEvidenceAccepted: z.literal(false),
    executionEvidenceAccepted: z.literal(false),
    scenarioSha256: Sha256,
    traceSha256: Sha256,
    stages: z.record(z.string(), z.enum(["completed", "missing", "failed"])),
    specialists: z.array(SpecialistAgent),
    decisionCount: z.number().int().nonnegative(),
    executionAttemptCount: z.number().int().nonnegative(),
    violations: z.array(FundHarnessViolation),
    runtimeSession: FundRuntimeSessionProofV1.optional(),
    semanticSha256: Sha256,
  })
  .strict()
export type FundRunManifestV1 = z.infer<typeof FundRunManifestV1>

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value)).digest("hex")
}

export function canonicalFundScenarioJson(scenario: FundHeadlessScenarioV1): string {
  return stable(FundHeadlessScenarioV1.parse(scenario))
}

export function fundScenarioSha256(scenario: FundHeadlessScenarioV1): string {
  return hash(FundHeadlessScenarioV1.parse(scenario))
}

export function fundTraceSha256(trace: FundHeadlessTraceV1): string {
  return hash(FundHeadlessTraceV1.parse(trace))
}

export async function loadFundScenario(file: string): Promise<FundHeadlessScenarioV1> {
  return FundHeadlessScenarioV1.parse(JSON.parse(await fs.readFile(file, "utf8")))
}

export async function loadFundTrace(file: string): Promise<FundHeadlessTraceV1> {
  return FundHeadlessTraceV1.parse(JSON.parse(await fs.readFile(file, "utf8")))
}

function one<T extends FundHeadlessTraceV1["events"][number]>(
  events: FundHeadlessTraceV1["events"],
  type: T["type"],
): T[] {
  return events.filter((event) => event.type === type) as T[]
}

/**
 * Structurally grades an untrusted static JSON fixture. A successful result is
 * deliberately `synthetic_validated`, never runtime, provider, approval,
 * execution, or paper-eligibility evidence.
 */
export function evaluateFundScenario(
  scenarioInput: FundHeadlessScenarioV1,
  traceInput: FundHeadlessTraceV1,
): FundRunManifestV1 {
  const scenario = FundHeadlessScenarioV1.parse(scenarioInput)
  const trace = FundHeadlessTraceV1.parse(traceInput)
  const violations: FundHarnessViolation[] = []
  const add = (code: string, message: string, evidence?: Record<string, unknown>) =>
    violations.push({ code, message, ...(evidence ? { evidence } : {}) })

  if (trace.scenarioId !== scenario.id) {
    add("scenario_mismatch", "Trace scenarioId does not match the scenario.", {
      expected: scenario.id,
      observed: trace.scenarioId,
    })
  }
  if (trace.model !== scenario.model) {
    add("model_mismatch", "Fund trace used a model outside the exact approved model pin.", {
      expected: scenario.model,
      observed: trace.model,
    })
  }

  const eventBindings = one<Extract<FundHeadlessTraceV1["events"][number], { type: "event_bound" }>>(
    trace.events,
    "event_bound",
  )
  if (eventBindings.length !== 1) {
    add("event_binding_count", "Exactly one event_bound record is required.", { observed: eventBindings.length })
  } else {
    const bound = eventBindings[0]
    if (
      bound.eventId !== scenario.event.eventId ||
      bound.eventType !== scenario.event.eventType ||
      bound.strategyId !== scenario.event.strategyId ||
      bound.strategyVersion !== scenario.event.strategyVersion
    ) {
      add("event_identity_mismatch", "Bound event identity does not exactly match the scenario.")
    }
  }

  const contexts = one<Extract<FundHeadlessTraceV1["events"][number], { type: "context_verified" }>>(
    trace.events,
    "context_verified",
  )
  if (contexts.length !== 1) {
    add("context_count", "Exactly one context_verified record is required.", { observed: contexts.length })
  } else if (contexts[0].portfolioSnapshotSha256 === contexts[0].marketSnapshotSha256) {
    add("context_hash_collision", "Portfolio and market snapshots must be independently bound.")
  }

  const specialistEvents = one<Extract<FundHeadlessTraceV1["events"][number], { type: "specialist_completed" }>>(
    trace.events,
    "specialist_completed",
  )
  const observedSpecialists = specialistEvents.map((event) => event.agent)
  const specialistSet = new Set(observedSpecialists)
  const specialistReportHashes = specialistEvents.map((event) => event.reportSha256)
  if (observedSpecialists.length > scenario.limits.specialists) {
    add("specialist_limit", "Observed specialist count exceeds the scenario limit.", {
      observed: observedSpecialists.length,
      limit: scenario.limits.specialists,
    })
  }
  if (specialistSet.size !== observedSpecialists.length) {
    add("duplicate_specialist", "Each specialist may complete at most once.")
  }
  if (new Set(specialistReportHashes).size !== specialistReportHashes.length) {
    add("duplicate_specialist_report", "Each specialist must produce a distinct immutable report hash.")
  }
  for (const required of scenario.expected.specialists) {
    if (!specialistSet.has(required)) {
      add("required_specialist_missing", `Required specialist "${required}" did not complete.`)
    }
  }
  for (const observed of specialistSet) {
    if (!scenario.expected.specialists.includes(observed)) {
      add("unexpected_specialist", `Unexpected specialist "${observed}" completed.`)
    }
  }

  const decisions = one<Extract<FundHeadlessTraceV1["events"][number], { type: "decision_proposed" }>>(
    trace.events,
    "decision_proposed",
  )
  if (decisions.length !== scenario.limits.decisions) {
    add("decision_count", "Decision count does not match the exact scenario limit.", {
      observed: decisions.length,
      expected: scenario.limits.decisions,
    })
  } else {
    if (decisions[0].action !== scenario.expected.action) {
      add("decision_mismatch", "Proposed action does not match the expected deterministic outcome.", {
        expected: scenario.expected.action,
        observed: decisions[0].action,
      })
    }
    if (decisions[0].riskTier !== scenario.expected.riskTier) {
      add("risk_tier_mismatch", "Proposed risk tier does not match the scenario policy.", {
        expected: scenario.expected.riskTier,
        observed: decisions[0].riskTier,
      })
    }
    if (decisions[0].executionAuthorized) {
      add("execution_authority_leak", "A Fund Manager proposal may never grant itself execution authority.")
    }
    if (decisions[0].openPositionPolicy !== "preserve_existing") {
      add("open_position_policy_violation", "A Fund Manager proposal may not modify an existing open position.")
    }
  }

  const approvals = one<Extract<FundHeadlessTraceV1["events"][number], { type: "approval_gated" }>>(
    trace.events,
    "approval_gated",
  )
  if (approvals.length !== 1) {
    add("approval_gate_count", "Exactly one approval_gated record is required.", { observed: approvals.length })
  } else {
    if (approvals[0].status === "approved") {
      add("synthetic_approval_claim", "A static offline fixture cannot establish or accept human-approval evidence.")
    }
    if (
      approvals[0].required !== scenario.expected.humanApprovalRequired ||
      (approvals[0].required && approvals[0].status === "not_required") ||
      (!approvals[0].required && approvals[0].status !== "not_required")
    ) {
      add("approval_gate_mismatch", "Approval gate does not match the scenario policy.")
    }
  }

  const executionAttempts = one<Extract<FundHeadlessTraceV1["events"][number], { type: "execution_attempted" }>>(
    trace.events,
    "execution_attempted",
  )
  if (scenario.forbidExecution && executionAttempts.length > 0) {
    add("execution_attempted", "The advisory harness forbids broker, deployment, and infrastructure execution.", {
      observed: executionAttempts.length,
    })
  }

  const positions = one<Extract<FundHeadlessTraceV1["events"][number], { type: "position_preserved" }>>(
    trace.events,
    "position_preserved",
  )
  if (scenario.expected.preserveOpenPosition) {
    const expected = scenario.event.openPosition!
    if (positions.length !== 1) {
      add("position_evidence_count", "Exactly one position_preserved record is required.", {
        observed: positions.length,
      })
    } else if (
      positions[0].positionId !== expected.positionId ||
      positions[0].beforeQuantity !== expected.quantity ||
      positions[0].afterQuantity !== expected.quantity
    ) {
      add("position_not_preserved", "The open position identity or quantity changed during advisory analysis.")
    }
  }

  const eventIndex = trace.events.findIndex((event) => event.type === "event_bound")
  const contextIndex = trace.events.findIndex((event) => event.type === "context_verified")
  const specialistIndexes = trace.events
    .map((event, index) => (event.type === "specialist_completed" ? index : -1))
    .filter((index) => index >= 0)
  const decisionIndex = trace.events.findIndex((event) => event.type === "decision_proposed")
  const approvalIndex = trace.events.findIndex((event) => event.type === "approval_gated")
  const positionIndex = trace.events.findIndex((event) => event.type === "position_preserved")
  const ordered =
    eventBindings.length === 1 &&
    contexts.length === 1 &&
    specialistEvents.length > 0 &&
    decisions.length === 1 &&
    approvals.length === 1 &&
    eventIndex < contextIndex &&
    contextIndex < Math.min(...specialistIndexes) &&
    Math.max(...specialistIndexes) < decisionIndex &&
    decisionIndex < approvalIndex &&
    (!scenario.expected.preserveOpenPosition || (positions.length === 1 && approvalIndex < positionIndex))
  if (!ordered) {
    add("stage_order_violation", "Trace stages must follow event, context, specialists, decision, approval, position.")
  }

  const stageCompletion = new Set<FundHarnessStageName>()
  if (eventBindings.length === 1 && !violations.some((item) => item.code.startsWith("event_"))) {
    stageCompletion.add("event_bound")
  }
  if (contexts.length === 1) stageCompletion.add("context_verified")
  if (
    scenario.expected.specialists.every((agent) => specialistSet.has(agent)) &&
    !violations.some((item) =>
      ["specialist_limit", "duplicate_specialist", "unexpected_specialist"].includes(item.code),
    )
  ) {
    stageCompletion.add("specialists_completed")
  }
  if (
    decisions.length === 1 &&
    !violations.some((item) => ["decision_count", "decision_mismatch", "execution_authority_leak"].includes(item.code))
  ) {
    stageCompletion.add("decision_proposed")
  }
  if (approvals.length === 1 && !violations.some((item) => item.code.startsWith("approval_"))) {
    stageCompletion.add("approval_gated")
  }
  if (
    !scenario.expected.preserveOpenPosition ||
    (positions.length === 1 && !violations.some((item) => item.code.startsWith("position_")))
  ) {
    stageCompletion.add("position_preserved")
  }

  const stages: Record<string, "completed" | "missing" | "failed"> = {}
  for (const stage of scenario.requiredStages) {
    const failed = violations.some((item) => item.code.startsWith(stage.split("_")[0]))
    stages[stage] = stageCompletion.has(stage) ? "completed" : failed ? "failed" : "missing"
    if (!stageCompletion.has(stage)) {
      add("required_stage_missing", `Required stage "${stage}" did not complete.`, { stage, status: stages[stage] })
    }
  }

  const contract = {
    scenarioId: scenario.id,
    model: trace.model,
    provenance: trace.provenance,
    stages,
    specialists: observedSpecialists,
    decisions: decisions.map((decision) => ({
      action: decision.action,
      riskTier: decision.riskTier,
      proposalSha256: decision.proposalSha256,
      executionAuthorized: decision.executionAuthorized,
      openPositionPolicy: decision.openPositionPolicy,
    })),
    executionAttempts: executionAttempts.map((event) => event.action),
    violations,
  }
  const status = violations.length === 0 ? ("synthetic_validated" as const) : ("contract_failed" as const)
  return FundRunManifestV1.parse({
    schemaVersion: "1.0.0",
    kind: "fund",
    scenarioId: scenario.id,
    status,
    exitCode: violations.length === 0 ? 0 : 2,
    model: trace.model,
    proofKind: "synthetic_fixture",
    evidenceMode: SYNTHETIC_OFFLINE_EVIDENCE,
    providerBacked: false,
    networkAccess: "disabled",
    paperEligible: false,
    approvalEvidenceAccepted: false,
    executionEvidenceAccepted: false,
    scenarioSha256: fundScenarioSha256(scenario),
    traceSha256: fundTraceSha256(trace),
    stages,
    specialists: observedSpecialists,
    decisionCount: decisions.length,
    executionAttemptCount: executionAttempts.length,
    violations,
    semanticSha256: hash(contract),
  })
}

function harnessAgentInfo(name: string): Agent.Info {
  return {
    name,
    description: `Deterministic offline harness identity for ${name}.`,
    mode: name === FUND_MANAGER_AGENT ? "primary" : "subagent",
    native: true,
    hidden: name !== FUND_MANAGER_AGENT,
    permission: [...effectiveFundRuntimePermission(name, [])],
    model: FUND_RUNTIME_MODEL,
    prompt: "",
    options: {},
  }
}

function harnessToolLayer(database: Database.Interface) {
  const agents = [FUND_MANAGER_AGENT, ...FUND_SPECIALIST_AGENTS].map(harnessAgentInfo)
  const byName = new Map(agents.map((agent) => [agent.name, agent]))
  const manager = byName.get(FUND_MANAGER_AGENT)!
  return Layer.mergeAll(
    Layer.succeed(
      Agent.Service,
      Agent.Service.of({
        get: (name) => {
          const agent = byName.get(name)
          return agent ? Effect.succeed(agent) : Effect.die(new Error(`Unknown harness agent "${name}".`))
        },
        list: () => Effect.succeed([...agents]),
        defaultInfo: () => Effect.succeed(manager),
        defaultAgent: () => Effect.succeed(FUND_MANAGER_AGENT),
        generate: () => Effect.die(new Error("The deterministic fund harness never invokes a model provider.")),
      }),
    ),
    Layer.succeed(
      Truncate.Service,
      Truncate.Service.of({
        cleanup: () => Effect.void,
        write: () => Effect.die(new Error("Deterministic harness output must not require filesystem truncation.")),
        output: (text) => Effect.succeed({ content: text, truncated: false }),
        limits: () => Effect.succeed({ maxLines: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }),
      }),
    ),
    Layer.succeed(Database.Service, database),
  )
}

async function harnessTools(database: Database.Interface) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const specialist = yield* FundSpecialistReportTool
      const draft = yield* FundActionDraftTool
      const proposal = yield* FundActionProposalTool
      return {
        specialist: yield* Tool.init(specialist),
        draft: yield* Tool.init(draft),
        proposal: yield* Tool.init(proposal),
      }
    }).pipe(Effect.provide(harnessToolLayer(database))),
  )
}

function harnessToolContext(input: {
  agent: string
  sessionID: SessionID
  parentSessionID?: SessionID
  nonce: string
}): Tool.Context {
  return {
    sessionID: input.sessionID,
    ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
    messageID: `msg_fund_harness_${input.nonce}` as MessageID,
    agent: input.agent,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.die(new Error("The deterministic offline harness cannot grant an approval.")),
  }
}

function reportRecommendation(
  action: FundHeadlessScenarioV1["expected"]["action"],
): FundSpecialistReportInput["recommendation"] {
  switch (action) {
    case "no_change":
      return "no_change"
    case "request_analysis":
      return "investigate"
    case "propose_pause":
      return "propose_pause"
    case "propose_resume":
      return "propose_resume"
    case "propose_strategy_build":
      return "propose_strategy_build"
    case "propose_strategy_deploy":
      return "propose_strategy_deploy"
    case "propose_strategy_rollback":
      return "propose_strategy_rollback"
    case "propose_logic_change":
      return "propose_logic_review"
    case "propose_paper_allocation_change":
      return "propose_paper_allocation_change"
  }
}

function makeCaseEvidence(
  scenario: FundHeadlessScenarioV1,
  trace: FundHeadlessTraceV1,
): FundActionProposalInput["evidence"] {
  const context = one<Extract<FundHeadlessTraceV1["events"][number], { type: "context_verified" }>>(
    trace.events,
    "context_verified",
  )[0]!
  return [
    {
      kind: "fund_event",
      ref: scenario.event.eventId,
      sha256: hash(scenario.event),
    },
    {
      kind: "portfolio_snapshot",
      ref: `portfolio-${scenario.id}`,
      sha256: context.portfolioSnapshotSha256,
    },
    {
      kind: "market_snapshot",
      ref: `market-${scenario.id}`,
      sha256: context.marketSnapshotSha256,
    },
  ]
}

function makeReportInput(input: {
  scenario: FundHeadlessScenarioV1
  agent: (typeof FUND_SPECIALIST_AGENTS)[number]
  caseEvidence: FundActionProposalInput["evidence"]
}): FundSpecialistReportInput {
  return {
    subject: `${input.agent} offline scenario review`,
    summary:
      `Synthetic offline deterministic review for ${input.scenario.id}; ` +
      "this fixture is not provider-backed and grants no execution authority.",
    recommendation: reportRecommendation(input.scenario.expected.action),
    confidence: 0.8,
    evidence: [input.caseEvidence[0]],
    riskFlags: [],
  }
}

function makeProposalInput(input: {
  scenario: FundHeadlessScenarioV1
  caseEvidence: FundActionProposalInput["evidence"]
  specialistReports: Array<{
    agent: (typeof FUND_SPECIALIST_AGENTS)[number]
    reportSha256: string
  }>
  draftSha256?: string
}): FundActionProposalInput {
  const portfolioSnapshot = input.caseEvidence.find((item) => item.kind === "portfolio_snapshot")!
  const marketSnapshot = input.caseEvidence.find((item) => item.kind === "market_snapshot")!
  return {
    action: input.scenario.expected.action,
    strategy: {
      strategyId: input.scenario.event.strategyId,
      version: input.scenario.event.strategyVersion,
      codeSha256: hash({ scenarioId: input.scenario.id, kind: "strategy_code" }),
      configSha256: hash({ scenarioId: input.scenario.id, kind: "strategy_config" }),
    },
    portfolioSnapshot,
    marketSnapshot,
    rationale:
      `Synthetic offline proposal for ${input.scenario.id}; ` +
      "the policy gateway remains the only possible execution authority.",
    confidence: 0.8,
    specialistReports: input.specialistReports,
    evidence: input.caseEvidence,
    contraryEvidence: [],
    ...(input.draftSha256 ? { draftSha256: input.draftSha256 } : {}),
  }
}

async function executeFundRuntimeSession(
  scenario: FundHeadlessScenarioV1,
  trace: FundHeadlessTraceV1,
): Promise<FundRuntimeSessionProofV1> {
  const violations: FundHarnessViolation[] = []
  const add = (code: string, message: string, evidence?: Record<string, unknown>) =>
    violations.push({ code, message, ...(evidence ? { evidence } : {}) })
  const permissionChecks: z.infer<typeof FundRuntimePermissionCheckV1>[] = []
  const toolCalls: z.infer<typeof FundRuntimeToolCallV1>[] = []
  const tasks: z.infer<typeof FundRuntimeTaskV1>[] = []
  const runKey = hash({ scenario, trace }).slice(0, 24)
  const managerSessionID = SessionID.descending(`ses_fund_harness_manager_${runKey}`)
  const childSessionIDs = new Map(
    scenario.expected.specialists.map((agent, index) => [
      agent,
      SessionID.descending(`ses_fund_harness_${index}_${runKey}`),
    ]),
  )

  const checkPermission = (
    agent: typeof FUND_MANAGER_AGENT | (typeof FUND_SPECIALIST_AGENTS)[number],
    permission: string,
    pattern: string,
    expected: "allow" | "deny",
  ) => {
    const observed = Permission.evaluate(permission, pattern, effectiveFundRuntimePermission(agent, [])).action
    permissionChecks.push({ agent, permission, pattern, expected, observed })
    if (observed !== expected) {
      add("runtime_permission_mismatch", "Runtime permission evaluation did not fail closed.", {
        agent,
        permission,
        pattern,
        expected,
        observed,
      })
    }
    return observed
  }

  checkPermission(FUND_MANAGER_AGENT, "finny_fund_action_propose", "*", "allow")
  checkPermission(FUND_MANAGER_AGENT, "finny_fund_action_draft", "*", "allow")
  checkPermission(FUND_MANAGER_AGENT, "finny_fund_specialist_report", "*", "deny")
  for (const specialist of scenario.expected.specialists) {
    checkPermission(FUND_MANAGER_AGENT, "task", specialist, "allow")
  }
  checkPermission(FUND_MANAGER_AGENT, "task", "build", "deny")
  for (const permission of ["bash", "edit", "write", "apply_patch", "paper_approve", "brokerage_switch"]) {
    checkPermission(FUND_MANAGER_AGENT, permission, "*", "deny")
  }
  for (const specialist of scenario.expected.specialists) {
    checkPermission(specialist, "finny_fund_specialist_report", "*", "allow")
    checkPermission(specialist, "finny_fund_action_draft", "*", "deny")
    checkPermission(specialist, "finny_fund_action_propose", "*", "deny")
    checkPermission(specialist, "task", "*", "deny")
    for (const permission of ["bash", "edit", "write", "apply_patch", "paper_approve", "brokerage_switch"]) {
      checkPermission(specialist, permission, "*", "deny")
    }
  }

  let managerSpecialistReportRejected = false
  let specialistActionProposalRejected = false
  const specialistNestedDelegationRejected = scenario.expected.specialists.every(
    (specialist) => fundDelegationError(specialist, "fund_risk_sentinel") !== undefined,
  )
  const unregisteredDelegationRejected = fundDelegationError(FUND_MANAGER_AGENT, "build") !== undefined
  const dangerousManagerPermissionsDenied = permissionChecks
    .filter(
      (item) =>
        item.agent === FUND_MANAGER_AGENT &&
        ["bash", "edit", "write", "apply_patch", "paper_approve", "brokerage_switch"].includes(item.permission),
    )
    .every((item) => item.observed === "deny")
  const dangerousSpecialistPermissionsDenied = permissionChecks
    .filter(
      (item) =>
        item.agent !== FUND_MANAGER_AGENT &&
        ["bash", "edit", "write", "apply_patch", "paper_approve", "brokerage_switch", "task"].includes(item.permission),
    )
    .every((item) => item.observed === "deny")

  let proposal: FundRuntimeSessionProofV1["proposal"]
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const tools = yield* Effect.promise(() => harnessTools(database))
      const projectID = "fund-harness" as (typeof ProjectTable.$inferInsert)["id"]
      const directory = "/tmp/finny-fund-harness" as (typeof ProjectTable.$inferInsert)["worktree"]
      yield* database.db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values([
          {
            id: managerSessionID,
            project_id: projectID,
            slug: `fund-manager-${runKey}`,
            directory,
            title: "Deterministic Fund Manager harness",
            version: "1",
            agent: FUND_MANAGER_AGENT,
            model: { providerID: FUND_RUNTIME_MODEL.providerID, id: FUND_RUNTIME_MODEL.modelID },
          },
          ...scenario.expected.specialists.map((agent) => ({
            id: childSessionIDs.get(agent)!,
            project_id: projectID,
            parent_id: managerSessionID,
            slug: `${agent}-${runKey}`,
            directory,
            title: `Deterministic ${agent} harness`,
            version: "1",
            agent,
            model: { providerID: FUND_RUNTIME_MODEL.providerID, id: FUND_RUNTIME_MODEL.modelID },
          })),
        ])
        .run()
        .pipe(Effect.orDie)

      const registeredReports: Array<{
        agent: (typeof FUND_SPECIALIST_AGENTS)[number]
        reportSha256: string
      }> = []
      const caseEvidence = makeCaseEvidence(scenario, trace)
      yield* Effect.promise(() =>
        FundCaseStore.admitCase(
          {
            managerSessionID,
            triggerMessageID: `msg_fund_trigger_${runKey}`,
            envelope: {
              eventType: scenario.event.eventType,
              sourceEventRef: scenario.event.eventId,
              payloadSha256: hash(scenario.event),
              occurredAt: "2000-01-01T00:00:00Z",
              evidence: caseEvidence,
            },
          },
          database,
        ),
      )

      const runSpecialist = (agent: (typeof FUND_SPECIALIST_AGENTS)[number], index: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const sessionID = childSessionIDs.get(agent)!
          const queued = yield* Effect.promise(() =>
            TaskState.upsert(
              {
                id: sessionID,
                parentSessionID: managerSessionID,
                description: `Deterministic offline ${agent} review`,
                subagentType: agent,
                mode: "foreground",
                status: TaskState.Status.queued,
              },
              database,
            ),
          )
          const running = yield* Effect.promise(() => TaskState.markRunning(sessionID, database))
          yield* Effect.promise(() =>
            FundCaseStore.admitChildAttempt(
              {
                managerSessionID,
                childSessionID: sessionID,
                agent,
              },
              database,
            ),
          )
          const reportInput = makeReportInput({ scenario, agent, caseEvidence })
          const result = yield* tools.specialist.execute(
            reportInput,
            harnessToolContext({
              agent,
              sessionID,
              parentSessionID: managerSessionID,
              nonce: `${runKey}_${index}`,
            }),
          )
          toolCalls.push({
            agent,
            tool: "finny_fund_specialist_report",
            accepted: result.metadata.accepted,
            outputSha256: hash(result.output),
          })
          if (!result.metadata.accepted || !result.metadata.report) {
            add("runtime_specialist_tool_rejected", "A required specialist report was rejected by the typed tool.", {
              agent,
              code: result.metadata.code,
            })
            yield* Effect.promise(() =>
              TaskState.finalizeActive(
                sessionID,
                { status: TaskState.Status.failed, lastError: result.metadata.code ?? "tool_rejected" },
                database,
              ),
            )
            return
          }
          const completed = yield* Effect.promise(() =>
            TaskState.finalizeActive(
              sessionID,
              {
                status: TaskState.Status.completed,
                resultSummary: result.metadata.report!.reportSha256,
              },
              database,
            ),
          )
          const persisted = yield* Effect.promise(() => TaskState.get(sessionID, database))
          if (
            queued.status !== TaskState.Status.queued ||
            running?.status !== TaskState.Status.running ||
            completed?.status !== TaskState.Status.completed ||
            persisted?.status !== TaskState.Status.completed ||
            persisted.parentSessionID !== managerSessionID ||
            persisted.subagentType !== agent
          ) {
            add("runtime_task_state_mismatch", "Specialist TaskState lifecycle or lineage did not persist exactly.", {
              agent,
              queued: queued.status,
              running: running?.status,
              completed: completed?.status,
              persisted: persisted?.status,
            })
          } else {
            tasks.push({
              agent,
              states: ["queued", "running", "completed"],
              reportSha256: result.metadata.report.reportSha256,
            })
          }
          registeredReports.push({ agent, reportSha256: result.metadata.report.reportSha256 })
        })

      const canonicalPolicy = FUND_ACTION_POLICY[scenario.expected.action]
      const material = canonicalPolicy.riskTier === "material_change"
      const reviewers = new Set<string>(FUND_DRAFT_REVIEWERS)
      const initialSpecialists = material
        ? scenario.expected.specialists.filter((agent) => !reviewers.has(agent))
        : scenario.expected.specialists
      const postDraftSpecialists = material ? scenario.expected.specialists.filter((agent) => reviewers.has(agent)) : []
      for (const agent of initialSpecialists) {
        yield* runSpecialist(agent, scenario.expected.specialists.indexOf(agent))
      }

      const sampleAgent = scenario.expected.specialists[0]
      const sampleSessionID = childSessionIDs.get(sampleAgent)!
      const managerReportAttempt = yield* tools.specialist.execute(
        makeReportInput({ scenario, agent: sampleAgent, caseEvidence }),
        harnessToolContext({
          agent: FUND_MANAGER_AGENT,
          sessionID: managerSessionID,
          nonce: `${runKey}_manager_report_bypass`,
        }),
      )
      managerSpecialistReportRejected = managerReportAttempt.metadata.accepted === false
      toolCalls.push({
        agent: FUND_MANAGER_AGENT,
        tool: "finny_fund_specialist_report",
        accepted: managerReportAttempt.metadata.accepted,
        outputSha256: hash(managerReportAttempt.output),
      })

      let draftSha256: string | undefined
      if (material) {
        const draftInput = makeProposalInput({
          scenario,
          caseEvidence,
          specialistReports: registeredReports,
        }) as FundActionDraftInput
        const draftResult = yield* tools.draft.execute(
          draftInput,
          harnessToolContext({
            agent: FUND_MANAGER_AGENT,
            sessionID: managerSessionID,
            nonce: `${runKey}_manager_draft`,
          }),
        )
        toolCalls.push({
          agent: FUND_MANAGER_AGENT,
          tool: "finny_fund_action_draft",
          accepted: draftResult.metadata.accepted,
          outputSha256: hash(draftResult.output),
        })
        if (!draftResult.metadata.accepted || !draftResult.metadata.draft) {
          add("runtime_draft_tool_rejected", "The material Fund Manager draft was rejected by the typed tool.", {
            code: draftResult.metadata.code,
          })
          return
        }
        draftSha256 = draftResult.metadata.draft.draftSha256
        for (const agent of postDraftSpecialists) {
          yield* runSpecialist(agent, scenario.expected.specialists.indexOf(agent))
        }
      }

      if (registeredReports.length !== scenario.expected.specialists.length) return
      const proposalInput = makeProposalInput({
        scenario,
        caseEvidence,
        specialistReports: registeredReports,
        draftSha256,
      })
      const specialistProposalAttempt = yield* tools.proposal.execute(
        proposalInput,
        harnessToolContext({
          agent: sampleAgent,
          sessionID: sampleSessionID,
          parentSessionID: managerSessionID,
          nonce: `${runKey}_specialist_proposal_bypass`,
        }),
      )
      specialistActionProposalRejected = specialistProposalAttempt.metadata.accepted === false
      toolCalls.push({
        agent: sampleAgent,
        tool: "finny_fund_action_propose",
        accepted: specialistProposalAttempt.metadata.accepted,
        outputSha256: hash(specialistProposalAttempt.output),
      })

      const result = yield* tools.proposal.execute(
        proposalInput,
        harnessToolContext({
          agent: FUND_MANAGER_AGENT,
          sessionID: managerSessionID,
          nonce: `${runKey}_manager_proposal`,
        }),
      )
      toolCalls.push({
        agent: FUND_MANAGER_AGENT,
        tool: "finny_fund_action_propose",
        accepted: result.metadata.accepted,
        outputSha256: hash(result.output),
      })
      if (!result.metadata.accepted || !result.metadata.proposal) {
        add("runtime_proposal_tool_rejected", "The Fund Manager proposal was rejected by the typed tool.", {
          code: result.metadata.code,
        })
        return
      }
      proposal = {
        action: result.metadata.proposal.action,
        riskTier: result.metadata.proposal.riskTier,
        proposalSha256: result.metadata.proposal.proposalSha256,
        executionAuthorized: result.metadata.proposal.executionAuthorized,
        humanApprovalRequired: result.metadata.proposal.humanApprovalRequired,
        gatewayReview: result.metadata.proposal.gatewayReview,
        openPositionPolicy: result.metadata.proposal.openPositionPolicy,
      }
      if (
        proposal.action !== scenario.expected.action ||
        proposal.riskTier !== scenario.expected.riskTier ||
        proposal.humanApprovalRequired !== scenario.expected.humanApprovalRequired
      ) {
        add("runtime_proposal_mismatch", "Typed proposal output does not match scenario policy.", {
          expectedAction: scenario.expected.action,
          observedAction: proposal.action,
          expectedRiskTier: scenario.expected.riskTier,
          observedRiskTier: proposal.riskTier,
          expectedHumanApprovalRequired: scenario.expected.humanApprovalRequired,
          observedHumanApprovalRequired: proposal.humanApprovalRequired,
        })
      }
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )

  if (!managerSpecialistReportRejected) {
    add("runtime_manager_report_bypass", "The specialist-report tool accepted the Fund Manager as a specialist.")
  }
  if (!specialistActionProposalRejected) {
    add("runtime_specialist_proposal_bypass", "The proposal tool accepted a specialist as Fund Manager.")
  }
  if (!specialistNestedDelegationRejected) {
    add("runtime_nested_delegation_bypass", "A specialist was allowed to delegate a nested task.")
  }
  if (!unregisteredDelegationRejected) {
    add("runtime_unregistered_delegation_bypass", "Fund Manager could delegate to an unregistered agent.")
  }
  if (!dangerousManagerPermissionsDenied || !dangerousSpecialistPermissionsDenied) {
    add("runtime_dangerous_permission", "A fund runtime identity retained a dangerous mutation permission.")
  }

  const boundaryChecks = {
    managerSpecialistReportRejected,
    specialistActionProposalRejected,
    specialistNestedDelegationRejected,
    unregisteredDelegationRejected,
    dangerousManagerPermissionsDenied,
    dangerousSpecialistPermissionsDenied,
  }
  const contract = {
    scenarioId: scenario.id,
    runtime: "deterministic_local",
    permissionChecks,
    toolCalls,
    tasks,
    proposal,
    boundaryChecks,
    violations,
  }
  return FundRuntimeSessionProofV1.parse({
    schemaVersion: "1.0.0",
    evidenceMode: SYNTHETIC_OFFLINE_EVIDENCE,
    runtime: "deterministic_local",
    providerBacked: false,
    networkAccess: "disabled",
    taskStateStore: "ephemeral_sqlite",
    managerAgent: FUND_MANAGER_AGENT,
    model: FUND_HARNESS_MODEL,
    permissionChecks,
    toolCalls,
    tasks,
    ...(proposal ? { proposal } : {}),
    boundaryChecks,
    violations,
    semanticSha256: hash(contract),
  })
}

/**
 * Adds deterministic local defense-in-depth proof: append-only case binding,
 * typed tool execution, permission evaluation, and persisted TaskState
 * lineage. It remains explicitly synthetic/offline and never calls a model or
 * market-data provider.
 */
export async function evaluateFundRuntimeScenario(
  scenarioInput: FundHeadlessScenarioV1,
  traceInput: FundHeadlessTraceV1,
): Promise<FundRunManifestV1> {
  const scenario = FundHeadlessScenarioV1.parse(scenarioInput)
  const trace = FundHeadlessTraceV1.parse(traceInput)
  const fixture = evaluateFundScenario(scenario, trace)
  if (fixture.status === "contract_failed") return fixture

  let runtimeSession: FundRuntimeSessionProofV1
  try {
    runtimeSession = await executeFundRuntimeSession(scenario, trace)
  } catch (error) {
    const violations = [
      ...fixture.violations,
      {
        code: "runtime_session_failed",
        message: "The deterministic local tool/permission/TaskState session failed closed.",
        evidence: { error: error instanceof Error ? error.message : String(error) },
      },
    ]
    return FundRunManifestV1.parse({
      ...fixture,
      status: "contract_failed",
      exitCode: 2,
      proofKind: "deterministic_runtime",
      violations,
      semanticSha256: hash({
        scenarioId: scenario.id,
        proofKind: "deterministic_runtime",
        violations,
      }),
    })
  }

  const violations = [...fixture.violations, ...runtimeSession.violations]
  const status = violations.length === 0 ? ("completed" as const) : ("contract_failed" as const)
  return FundRunManifestV1.parse({
    ...fixture,
    status,
    exitCode: status === "completed" ? 0 : 2,
    proofKind: "deterministic_runtime",
    violations,
    runtimeSession,
    semanticSha256: hash({
      scenarioId: scenario.id,
      fixtureSemanticSha256: fixture.semanticSha256,
      runtimeSemanticSha256: runtimeSession.semanticSha256,
      status,
      violations,
    }),
  })
}

export async function runFundScenarioFiles(input: {
  scenarioPath: string
  tracePath: string
  outputPath?: string
}): Promise<FundRunManifestV1> {
  const manifest = await evaluateFundRuntimeScenario(
    await loadFundScenario(input.scenarioPath),
    await loadFundTrace(input.tracePath),
  )
  if (input.outputPath) await fs.writeFile(input.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return manifest
}
