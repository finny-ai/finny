import crypto from "node:crypto"
import {
  FundCaseChildTable,
  FundCaseDraftTable,
  FundCaseProposalTable,
  FundCaseReportAdmissionTable,
  FundCaseReportSubmissionTable,
  FundCaseTable,
} from "@opencode-ai/core/fund/case.sql"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { TaskRunTable } from "@opencode-ai/core/task/sql"
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import {
  FUND_ACTION_POLICY,
  FUND_DRAFT_REVIEWERS,
  FUND_MANAGER_AGENT,
  FUND_SPECIALIST_AGENTS,
  fundSpecialistRole,
  isFundSpecialistAgent,
  type FundActionType,
  type FundRiskTier,
  type FundSpecialistAgent,
  type FundSpecialistRole,
} from "@/agent/fund-policy"
import { TaskState } from "@/task/state"
import type { SessionID } from "@/session/schema"
import { makeRuntime } from "@/effect/run-service"

export type FundEvidenceKind =
  | "fund_event"
  | "market_snapshot"
  | "portfolio_snapshot"
  | "position_snapshot"
  | "strategy_version"
  | "regime_observation"
  | "fill"
  | "backtest_run"
  | "review_packet"
  | "specialist_report"
  | "fund_policy"
  | "news_context"

export type FundEvidenceReference = {
  kind: FundEvidenceKind
  ref: string
  sha256: string
}

export type FundCaseEnvelope = {
  eventType: string
  sourceEventRef: string
  payloadSha256: string
  occurredAt?: string
  evidence: readonly FundEvidenceReference[]
}

export type FundCaseContract = {
  caseId: string
  managerSessionID: string
  triggerMessageID: string
  eventId: string
  eventType: string
  sourceEventRef: string
  eventSha256: string
  evidence: FundEvidenceReference[]
  evidenceSha256: string
  admittedAt: number
}

export type FundStrategyReference = {
  strategyId: string
  version: number
  codeSha256: string
  configSha256: string
}

export type FundReportReference = {
  agent: FundSpecialistAgent
  reportSha256: string
}

export type FundReportSubmissionInput = {
  subject: string
  summary: string
  recommendation:
    | "no_change"
    | "investigate"
    | "propose_pause"
    | "propose_resume"
    | "propose_strategy_build"
    | "propose_strategy_deploy"
    | "propose_strategy_rollback"
    | "propose_logic_review"
    | "propose_paper_allocation_change"
    | "escalate_human"
  confidence: number
  evidence: FundEvidenceReference[]
  riskFlags: (
    | "data_quality"
    | "market_mismatch"
    | "strategy_mismatch"
    | "position_risk"
    | "execution_anomaly"
    | "model_uncertainty"
  )[]
}

export type FundReportAttestation = {
  attestationId: string
  caseId: string
  managerSessionID: string
  specialistSessionID: string
  specialist: FundSpecialistRole
  agent: FundSpecialistAgent
  reportSha256: string
  draftSha256?: string
  submittedAt: number
  admittedAt: number
  report: FundReportSubmissionInput
}

export type FundProposalBody = {
  action: FundActionType
  strategy?: FundStrategyReference
  portfolioSnapshot?: FundEvidenceReference
  marketSnapshot?: FundEvidenceReference
  rationale: string
  confidence: number
  specialistReports: FundReportReference[]
  evidence: FundEvidenceReference[]
  contraryEvidence: FundEvidenceReference[]
  draftSha256?: string
}

export type FundActionDraft = FundProposalBody & {
  caseId: string
  eventId: string
  eventType: string
  draftSha256: string
  riskTier: FundRiskTier
  humanApprovalRequired: boolean
  createdAt: number
}

export type FundActionProposal = FundProposalBody & {
  caseId: string
  eventId: string
  eventType: string
  proposedAt: string
  idempotencyKey: string
  proposalSha256: string
  executionAuthorized: false
  gatewayReview: "not_executable" | "required"
  humanApprovalRequired: boolean
  riskTier: FundRiskTier
  openPositionPolicy: "preserve_existing"
}

const APPEND_ONLY_TABLES = [
  "fund_case",
  "fund_case_child",
  "fund_case_report_submission",
  "fund_case_report_admission",
  "fund_case_draft",
  "fund_case_proposal",
] as const

const hardened = new WeakSet<object>()

const FundCaseStoreErrorCode = Schema.Literals([
  "case_not_admitted",
  "case_mismatch",
  "duplicate_case",
  "invalid_lineage",
  "attempt_budget_exhausted",
  "specialist_active",
  "specialist_completed",
  "draft_required",
  "draft_mismatch",
  "evidence_mismatch",
  "report_not_completed",
  "report_missing",
  "report_already_submitted",
  "proposal_already_finalized",
  "required_specialist_missing",
])

export class FundCaseStoreError extends Schema.TaggedErrorClass<FundCaseStoreError>()("FundCaseStoreError", {
  code: FundCaseStoreErrorCode,
  message: Schema.String,
}) {}

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

export function fundCaseSha256(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value)).digest("hex")
}

function opaque(prefix: string, value: unknown): string {
  return `${prefix}_${fundCaseSha256(value).slice(0, 32)}`
}

function evidenceKey(value: FundEvidenceReference): string {
  return `${value.kind}\u0000${value.ref}\u0000${value.sha256}`
}

function canonicalEvidence(values: readonly FundEvidenceReference[]): FundEvidenceReference[] {
  return [...new Map(values.map((value) => [evidenceKey(value), { ...value }])).values()].toSorted((a, b) =>
    evidenceKey(a).localeCompare(evidenceKey(b)),
  )
}

function parseEvidence(value: string): FundEvidenceReference[] {
  return JSON.parse(value) as FundEvidenceReference[]
}

function parseReport(value: typeof FundCaseReportSubmissionTable.$inferSelect): FundReportSubmissionInput {
  return {
    subject: value.subject,
    summary: value.summary,
    recommendation: value.recommendation as FundReportSubmissionInput["recommendation"],
    confidence: value.confidence,
    evidence: parseEvidence(value.evidence_json),
    riskFlags: JSON.parse(value.risk_flags_json) as FundReportSubmissionInput["riskFlags"],
  }
}

function caseFromRow(row: typeof FundCaseTable.$inferSelect): FundCaseContract {
  return {
    caseId: row.case_id,
    managerSessionID: row.manager_session_id,
    triggerMessageID: row.trigger_message_id,
    eventId: row.event_id,
    eventType: row.event_type,
    sourceEventRef: row.source_event_ref,
    eventSha256: row.event_sha256,
    evidence: parseEvidence(row.evidence_json),
    evidenceSha256: row.evidence_sha256,
    admittedAt: row.time_created,
  }
}

function approvalRequired(riskTier: FundRiskTier): boolean {
  return riskTier === "material_change"
}

function assertEvidence(caseRecord: FundCaseContract, references: readonly FundEvidenceReference[]) {
  const admitted = new Set(caseRecord.evidence.map(evidenceKey))
  for (const reference of references) {
    if (!admitted.has(evidenceKey(reference))) {
      throw new FundCaseStoreError({
        code: "evidence_mismatch",
        message: `Evidence ${reference.kind}:${reference.ref} is not bound to ${caseRecord.caseId}.`,
      })
    }
  }
}

function assertEvidencePartition(input: FundProposalBody) {
  const references = [...input.evidence, ...input.contraryEvidence]
  if (new Set(references.map(evidenceKey)).size !== references.length) {
    throw new FundCaseStoreError({
      code: "evidence_mismatch",
      message:
        "Supporting and contrary evidence must contain unique, disjoint references.",
    })
  }
}

function assertEventEnvelope(envelope: FundCaseEnvelope) {
  const sourceReferences = envelope.evidence.filter(
    (reference) =>
      reference.kind === "fund_event" &&
      reference.ref === envelope.sourceEventRef &&
      reference.sha256 === envelope.payloadSha256,
  )
  if (sourceReferences.length !== 1) {
    throw new FundCaseStoreError({
      code: "evidence_mismatch",
      message: "Fund event evidence must bind the exact source event and payload digest once.",
    })
  }
}

function assertSnapshotKinds(input: FundProposalBody) {
  const advisoryWithoutSnapshots = input.action === "request_analysis" || input.action === "propose_strategy_build"
  if (!advisoryWithoutSnapshots && input.portfolioSnapshot?.kind !== "portfolio_snapshot") {
    throw new FundCaseStoreError({
      code: "evidence_mismatch",
      message: "A bound portfolio_snapshot is required for this action.",
    })
  }
  if (!advisoryWithoutSnapshots && input.marketSnapshot?.kind !== "market_snapshot") {
    throw new FundCaseStoreError({
      code: "evidence_mismatch",
      message: "A bound market_snapshot is required for this action.",
    })
  }
  if (input.portfolioSnapshot && input.portfolioSnapshot.kind !== "portfolio_snapshot") {
    throw new FundCaseStoreError({
      code: "evidence_mismatch",
      message: "portfolioSnapshot must have kind portfolio_snapshot.",
    })
  }
  if (input.marketSnapshot && input.marketSnapshot.kind !== "market_snapshot") {
    throw new FundCaseStoreError({
      code: "evidence_mismatch",
      message: "marketSnapshot must have kind market_snapshot.",
    })
  }
}

async function run<A>(
  database: Database.Interface | undefined,
  effect: (database: Database.Interface) => Effect.Effect<A, unknown>,
): Promise<A> {
  if (database) return Effect.runPromise(effect(database))
  return runtime.runPromise(effect)
}

const runtime = makeRuntime(Database.Service, Database.defaultLayer)

function ensureAppendOnly(database: Database.Interface) {
  if (hardened.has(database)) return Effect.void
  return Effect.gen(function* () {
    for (const table of APPEND_ONLY_TABLES) {
      yield* database.db.run(
        sql.raw(
          `CREATE TRIGGER IF NOT EXISTS ${table}_reject_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
        ),
      )
      yield* database.db.run(
        sql.raw(
          `CREATE TRIGGER IF NOT EXISTS ${table}_reject_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
        ),
      )
    }
    hardened.add(database)
  })
}

function withStore<A, E>(database: Database.Interface, effect: Effect.Effect<A, E>) {
  return ensureAppendOnly(database).pipe(Effect.andThen(effect))
}

export * as FundCaseStore from "./case-store"
export async function admitCase(
  input: {
    managerSessionID: string
    triggerMessageID: string
    envelope: FundCaseEnvelope
  },
  database?: Database.Interface,
): Promise<FundCaseContract> {
  assertEventEnvelope(input.envelope)
  return run(database, (service) =>
    withStore(
      service,
      service.db.transaction((tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(FundCaseTable)
            .where(eq(FundCaseTable.trigger_message_id, input.triggerMessageID))
            .get()
          const evidence = canonicalEvidence(input.envelope.evidence)
          const eventBinding = {
            managerSessionID: input.managerSessionID,
            triggerMessageID: input.triggerMessageID,
            eventType: input.envelope.eventType,
            sourceEventRef: input.envelope.sourceEventRef,
            payloadSha256: input.envelope.payloadSha256,
            occurredAt: input.envelope.occurredAt,
            evidence,
          }
          const caseId = opaque("case", eventBinding)
          const eventId = opaque("evt", eventBinding)
          const eventSha256 = fundCaseSha256(eventBinding)
          const evidenceSha256 = fundCaseSha256(evidence)
          const idempotencyKey = opaque("case_admit", { caseId, eventId, eventSha256 })
          if (existing) {
            const current = caseFromRow(existing)
            if (
              current.caseId !== caseId ||
              current.managerSessionID !== input.managerSessionID ||
              current.eventSha256 !== eventSha256
            ) {
              return yield* new FundCaseStoreError({
                code: "duplicate_case",
                message: "The trigger message is already bound to a different immutable fund event.",
              })
            }
            return current
          }
          const manager = yield* tx
            .select({ agent: SessionTable.agent })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.managerSessionID as SessionID))
            .get()
          if (manager?.agent !== FUND_MANAGER_AGENT) {
            return yield* new FundCaseStoreError({
              code: "invalid_lineage",
              message: "Fund cases may be admitted only for a canonical Fund Manager session.",
            })
          }
          const admittedAt = Date.now()
          yield* tx
            .insert(FundCaseTable)
            .values({
              case_id: caseId,
              manager_session_id: input.managerSessionID,
              trigger_message_id: input.triggerMessageID,
              event_id: eventId,
              event_type: input.envelope.eventType,
              source_event_ref: input.envelope.sourceEventRef,
              event_sha256: eventSha256,
              evidence_json: stable(evidence),
              evidence_sha256: evidenceSha256,
              idempotency_key: idempotencyKey,
              time_created: admittedAt,
            })
            .run()
          return {
            caseId,
            managerSessionID: input.managerSessionID,
            triggerMessageID: input.triggerMessageID,
            eventId,
            eventType: input.envelope.eventType,
            sourceEventRef: input.envelope.sourceEventRef,
            eventSha256,
            evidence,
            evidenceSha256,
            admittedAt,
          } satisfies FundCaseContract
        }),
      ),
    ),
  )
}

export async function getByTriggerMessage(
  triggerMessageID: string,
  database?: Database.Interface,
): Promise<FundCaseContract | undefined> {
  return run(database, (service) =>
    withStore(
      service,
      service.db
        .select()
        .from(FundCaseTable)
        .where(eq(FundCaseTable.trigger_message_id, triggerMessageID))
        .get()
        .pipe(
          Effect.map((row) => (row ? caseFromRow(row) : undefined)),
          Effect.orDie,
        ),
    ),
  )
}

export async function latestByManager(
  managerSessionID: string,
  database?: Database.Interface,
): Promise<FundCaseContract | undefined> {
  return run(database, (service) =>
    withStore(
      service,
      service.db
        .select()
        .from(FundCaseTable)
        .where(eq(FundCaseTable.manager_session_id, managerSessionID))
        .orderBy(desc(FundCaseTable.time_created), desc(FundCaseTable.case_id))
        .get()
        .pipe(
          Effect.map((row) => (row ? caseFromRow(row) : undefined)),
          Effect.orDie,
        ),
    ),
  )
}

export async function caseForManagerTurn(
  managerSessionID: string,
  triggerMessageID: string | undefined,
  database?: Database.Interface,
): Promise<FundCaseContract | undefined> {
  if (triggerMessageID) {
    const exact = await getByTriggerMessage(triggerMessageID, database)
    return exact?.managerSessionID === managerSessionID ? exact : undefined
  }
  return latestByManager(managerSessionID, database)
}

export async function specialistLaunchStatus(
  input: {
    managerSessionID: string
    triggerMessageID?: string
    agent: FundSpecialistAgent
  },
  database?: Database.Interface,
): Promise<
  | { allowed: true; caseRecord: FundCaseContract; attemptNo: 1 | 2; draftSha256?: string }
  | {
      allowed: false
      code: "case_not_admitted" | "attempt_budget_exhausted" | "specialist_active" | "specialist_completed"
      message: string
    }
> {
  const caseRecord = await caseForManagerTurn(input.managerSessionID, input.triggerMessageID, database)
  if (!caseRecord) {
    return {
      allowed: false,
      code: "case_not_admitted",
      message: "No immutable fund event is admitted for this Fund Manager turn.",
    }
  }
  return run(database, (service) =>
    withStore(
      service,
      Effect.gen(function* () {
        const children = yield* service.db
          .select()
          .from(FundCaseChildTable)
          .where(and(eq(FundCaseChildTable.case_id, caseRecord.caseId), eq(FundCaseChildTable.role, input.agent)))
          .orderBy(asc(FundCaseChildTable.attempt_no))
          .all()
        const currentDraft = FUND_DRAFT_REVIEWERS.includes(input.agent as (typeof FUND_DRAFT_REVIEWERS)[number])
          ? yield* service.db
              .select({ draftSha256: FundCaseDraftTable.draft_sha256 })
              .from(FundCaseDraftTable)
              .where(eq(FundCaseDraftTable.case_id, caseRecord.caseId))
              .get()
          : undefined
        for (const child of children) {
          const task = yield* service.db
            .select({ status: TaskRunTable.status })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.id, child.child_session_id as SessionID))
            .get()
          if (task && !TaskState.isTerminal(task.status as TaskState.Status)) {
            return {
              allowed: false as const,
              code: "specialist_active" as const,
              message: `${input.agent} already has an active admitted child for ${caseRecord.caseId}.`,
            }
          }
          if (task?.status === TaskState.Status.completed) {
            const report = yield* service.db
              .select({
                id: FundCaseReportSubmissionTable.submission_id,
                draftSha256: FundCaseReportSubmissionTable.draft_sha256,
              })
              .from(FundCaseReportSubmissionTable)
              .where(eq(FundCaseReportSubmissionTable.child_session_id, child.child_session_id))
              .get()
            const staleMaterialReview = currentDraft && report && report.draftSha256 !== currentDraft.draftSha256
            if (report && !staleMaterialReview) {
              return {
                allowed: false as const,
                code: "specialist_completed" as const,
                message: `${input.agent} already completed its one admitted report for ${caseRecord.caseId}.`,
              }
            }
          }
        }
        if (children.length >= 2) {
          return {
            allowed: false as const,
            code: "attempt_budget_exhausted" as const,
            message: `${input.agent} exhausted the two-attempt budget for ${caseRecord.caseId}.`,
          }
        }
        const draftSha256 = currentDraft?.draftSha256
        return {
          allowed: true as const,
          caseRecord,
          attemptNo: (children.length + 1) as 1 | 2,
          draftSha256,
        }
      }).pipe(Effect.orDie),
    ),
  )
}

export async function admitChildAttempt(
  input: {
    managerSessionID: string
    triggerMessageID?: string
    childSessionID: string
    agent: FundSpecialistAgent
  },
  database?: Database.Interface,
): Promise<{ caseRecord: FundCaseContract; attemptNo: 1 | 2; draftSha256?: string }> {
  const launch = await specialistLaunchStatus(
    {
      managerSessionID: input.managerSessionID,
      triggerMessageID: input.triggerMessageID,
      agent: input.agent,
    },
    database,
  )
  if (!launch.allowed) throw new FundCaseStoreError({ code: launch.code, message: launch.message })
  return run(database, (service) =>
    withStore(
      service,
      service.db.transaction((tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(FundCaseChildTable)
            .where(eq(FundCaseChildTable.child_session_id, input.childSessionID))
            .get()
          if (existing) {
            if (
              existing.case_id !== launch.caseRecord.caseId ||
              existing.manager_session_id !== input.managerSessionID ||
              existing.role !== input.agent
            ) {
              return yield* new FundCaseStoreError({
                code: "invalid_lineage",
                message: "The child session is already bound to another case, parent, or specialist role.",
              })
            }
            return {
              caseRecord: launch.caseRecord,
              attemptNo: existing.attempt_no as 1 | 2,
              draftSha256: existing.draft_sha256 ?? undefined,
            }
          }
          const task = yield* tx
            .select()
            .from(TaskRunTable)
            .where(eq(TaskRunTable.id, input.childSessionID as SessionID))
            .get()
          if (
            !task ||
            task.parent_session_id !== input.managerSessionID ||
            task.subagent_type !== input.agent ||
            TaskState.isTerminal(task.status as TaskState.Status)
          ) {
            return yield* new FundCaseStoreError({
              code: "invalid_lineage",
              message: "A live canonical TaskState row with matching parent and role is required.",
            })
          }
          const total = yield* tx
            .select({ count: count() })
            .from(FundCaseChildTable)
            .where(
              and(eq(FundCaseChildTable.case_id, launch.caseRecord.caseId), eq(FundCaseChildTable.role, input.agent)),
            )
            .get()
          const attemptNo = Number(total?.count ?? 0) + 1
          if (attemptNo > 2) {
            return yield* new FundCaseStoreError({
              code: "attempt_budget_exhausted",
              message: `${input.agent} exhausted the two-attempt budget for ${launch.caseRecord.caseId}.`,
            })
          }
          yield* tx
            .insert(FundCaseChildTable)
            .values({
              child_session_id: input.childSessionID,
              case_id: launch.caseRecord.caseId,
              manager_session_id: input.managerSessionID,
              role: input.agent,
              attempt_no: attemptNo,
              draft_sha256: launch.draftSha256 ?? null,
              time_created: Date.now(),
            })
            .run()
          return {
            caseRecord: launch.caseRecord,
            attemptNo: attemptNo as 1 | 2,
            draftSha256: launch.draftSha256,
          }
        }),
      ),
    ),
  )
}

export async function validateChildLineage(
  input: {
    managerSessionID: string
    childSessionID: string
    agent: FundSpecialistAgent
    activeOnly?: boolean
  },
  database?: Database.Interface,
): Promise<boolean> {
  return run(database, (service) =>
    withStore(
      service,
      Effect.gen(function* () {
        const child = yield* service.db
          .select()
          .from(FundCaseChildTable)
          .where(eq(FundCaseChildTable.child_session_id, input.childSessionID))
          .get()
        if (!child || child.manager_session_id !== input.managerSessionID || child.role !== input.agent) return false
        const task = yield* service.db
          .select()
          .from(TaskRunTable)
          .where(eq(TaskRunTable.id, input.childSessionID as SessionID))
          .get()
        if (!task || task.parent_session_id !== input.managerSessionID || task.subagent_type !== input.agent)
          return false
        return input.activeOnly ? !TaskState.isTerminal(task.status as TaskState.Status) : true
      }).pipe(Effect.orDie),
    ),
  )
}

export async function childContext(childSessionID: string, database?: Database.Interface): Promise<string | undefined> {
  return run(database, (service) =>
    withStore(
      service,
      Effect.gen(function* () {
        const child = yield* service.db
          .select()
          .from(FundCaseChildTable)
          .where(eq(FundCaseChildTable.child_session_id, childSessionID))
          .get()
        if (!child) return
        const row = yield* service.db.select().from(FundCaseTable).where(eq(FundCaseTable.case_id, child.case_id)).get()
        if (!row) return
        const contract = caseFromRow(row)
        const draft = child.draft_sha256
          ? yield* service.db
              .select({ payload: FundCaseDraftTable.payload_json })
              .from(FundCaseDraftTable)
              .where(eq(FundCaseDraftTable.draft_sha256, child.draft_sha256))
              .get()
          : undefined
        return [
          "<fund-case-contract>",
          stable({
            caseId: contract.caseId,
            eventId: contract.eventId,
            eventType: contract.eventType,
            eventSha256: contract.eventSha256,
            evidence: contract.evidence,
            specialistRole: child.role,
            attemptNo: child.attempt_no,
            ...(child.draft_sha256 ? { materialDraftSha256: child.draft_sha256, materialDraft: draft?.payload } : {}),
          }),
          "</fund-case-contract>",
        ].join("\n")
      }).pipe(Effect.orDie),
    ),
  )
}

export async function submitReport(
  input: {
    managerSessionID: string
    specialistSessionID: string
    agent: FundSpecialistAgent
    report: FundReportSubmissionInput
  },
  database?: Database.Interface,
): Promise<{
  caseId: string
  eventId: string
  eventType: string
  specialist: FundSpecialistRole
  reportSha256: string
  submittedAt: number
  draftSha256?: string
  report: FundReportSubmissionInput
}> {
  return run(database, (service) =>
    withStore(
      service,
      service.db.transaction((tx) =>
        Effect.gen(function* () {
          const child = yield* tx
            .select()
            .from(FundCaseChildTable)
            .where(eq(FundCaseChildTable.child_session_id, input.specialistSessionID))
            .get()
          const task = yield* tx
            .select()
            .from(TaskRunTable)
            .where(eq(TaskRunTable.id, input.specialistSessionID as SessionID))
            .get()
          if (
            !child ||
            !task ||
            child.manager_session_id !== input.managerSessionID ||
            child.role !== input.agent ||
            task.parent_session_id !== input.managerSessionID ||
            task.subagent_type !== input.agent ||
            task.status !== TaskState.Status.running
          ) {
            return yield* new FundCaseStoreError({
              code: "invalid_lineage",
              message: "Report submission requires the matching running specialist child TaskState.",
            })
          }
          const prior = yield* tx
            .select()
            .from(FundCaseReportSubmissionTable)
            .where(eq(FundCaseReportSubmissionTable.child_session_id, input.specialistSessionID))
            .get()
          if (prior) {
            return yield* new FundCaseStoreError({
              code: "report_already_submitted",
              message: "Each admitted specialist child may submit exactly one report.",
            })
          }
          const caseRow = yield* tx.select().from(FundCaseTable).where(eq(FundCaseTable.case_id, child.case_id)).get()
          if (!caseRow) {
            return yield* new FundCaseStoreError({
              code: "case_not_admitted",
              message: "The child case no longer exists.",
            })
          }
          const caseRecord = caseFromRow(caseRow)
          const evidence = canonicalEvidence(input.report.evidence)
          yield* Effect.try({
            try: () => assertEvidence(caseRecord, evidence),
            catch: (error) =>
              error instanceof FundCaseStoreError
                ? error
                : new FundCaseStoreError({
                    code: "evidence_mismatch",
                    message: "Specialist evidence validation failed.",
                  }),
          })
          const specialist = fundSpecialistRole(input.agent)!
          const submittedAt = Date.now()
          const report = {
            subject: input.report.subject,
            summary: input.report.summary,
            recommendation: input.report.recommendation,
            confidence: input.report.confidence,
            evidence,
            riskFlags: [...new Set(input.report.riskFlags)].toSorted(),
          }
          const reportBinding = {
            caseId: caseRecord.caseId,
            eventId: caseRecord.eventId,
            eventSha256: caseRecord.eventSha256,
            managerSessionID: input.managerSessionID,
            specialistSessionID: input.specialistSessionID,
            specialist,
            agent: input.agent,
            attemptNo: child.attempt_no,
            draftSha256: child.draft_sha256 ?? undefined,
            report,
          }
          const reportSha256 = fundCaseSha256(reportBinding)
          const submissionId = opaque("fund_report_submission", reportBinding)
          yield* tx
            .insert(FundCaseReportSubmissionTable)
            .values({
              submission_id: submissionId,
              case_id: caseRecord.caseId,
              manager_session_id: input.managerSessionID,
              child_session_id: input.specialistSessionID,
              role: input.agent,
              subject: report.subject,
              summary: report.summary,
              recommendation: report.recommendation,
              confidence: report.confidence,
              evidence_json: stable(report.evidence),
              evidence_sha256: fundCaseSha256(report.evidence),
              risk_flags_json: stable(report.riskFlags),
              draft_sha256: child.draft_sha256 ?? null,
              report_sha256: reportSha256,
              submitted_at: submittedAt,
            })
            .run()
          return {
            caseId: caseRecord.caseId,
            eventId: caseRecord.eventId,
            eventType: caseRecord.eventType,
            specialist,
            reportSha256,
            submittedAt,
            draftSha256: child.draft_sha256 ?? undefined,
            report,
          }
        }),
      ),
    ),
  )
}

async function admitCompletedReports(
  caseRecord: FundCaseContract,
  references: readonly FundReportReference[],
  database?: Database.Interface,
): Promise<FundReportAttestation[]> {
  if (references.length === 0) return []
  return run(database, (service) =>
    withStore(
      service,
      service.db.transaction((tx) =>
        Effect.gen(function* () {
          const reports = yield* tx
            .select()
            .from(FundCaseReportSubmissionTable)
            .where(
              and(
                eq(FundCaseReportSubmissionTable.case_id, caseRecord.caseId),
                inArray(
                  FundCaseReportSubmissionTable.report_sha256,
                  references.map((reference) => reference.reportSha256),
                ),
              ),
            )
            .all()
          const reportsBySha = new Map(reports.map((report) => [report.report_sha256, report]))
          const attestations: FundReportAttestation[] = []
          for (const reference of references) {
            const report = reportsBySha.get(reference.reportSha256)
            if (!report || report.role !== reference.agent || !isFundSpecialistAgent(reference.agent)) {
              return yield* new FundCaseStoreError({
                code: "report_missing",
                message: `The referenced ${reference.agent} report was not submitted for ${caseRecord.caseId}.`,
              })
            }
            const task = yield* tx
              .select()
              .from(TaskRunTable)
              .where(eq(TaskRunTable.id, report.child_session_id as SessionID))
              .get()
            if (
              !task ||
              task.status !== TaskState.Status.completed ||
              task.parent_session_id !== caseRecord.managerSessionID ||
              task.subagent_type !== reference.agent
            ) {
              return yield* new FundCaseStoreError({
                code: "report_not_completed",
                message: `${reference.agent} report cannot be admitted before its exact child TaskState completes.`,
              })
            }
            let admission = yield* tx
              .select()
              .from(FundCaseReportAdmissionTable)
              .where(eq(FundCaseReportAdmissionTable.submission_id, report.submission_id))
              .get()
            if (!admission) {
              const admittedAt = Date.now()
              const attestationId = opaque("fund_report_attestation", {
                caseId: caseRecord.caseId,
                submissionId: report.submission_id,
                reportSha256: report.report_sha256,
                admittedAt,
              })
              yield* tx
                .insert(FundCaseReportAdmissionTable)
                .values({
                  attestation_id: attestationId,
                  case_id: caseRecord.caseId,
                  submission_id: report.submission_id,
                  child_session_id: report.child_session_id,
                  role: report.role,
                  report_sha256: report.report_sha256,
                  admitted_at: admittedAt,
                })
                .run()
              admission = {
                attestation_id: attestationId,
                case_id: caseRecord.caseId,
                submission_id: report.submission_id,
                child_session_id: report.child_session_id,
                role: report.role,
                report_sha256: report.report_sha256,
                admitted_at: admittedAt,
              }
            }
            attestations.push({
              attestationId: admission.attestation_id,
              caseId: caseRecord.caseId,
              managerSessionID: caseRecord.managerSessionID,
              specialistSessionID: report.child_session_id,
              specialist: fundSpecialistRole(reference.agent)!,
              agent: reference.agent,
              reportSha256: report.report_sha256,
              draftSha256: report.draft_sha256 ?? undefined,
              submittedAt: report.submitted_at,
              admittedAt: admission.admitted_at,
              report: parseReport(report),
            })
          }
          return attestations
        }),
      ),
    ),
  )
}

function requiredReports(action: FundActionType) {
  return FUND_ACTION_POLICY[action].requiredSpecialists
}

function validateRequiredReports(
  action: FundActionType,
  attestations: readonly FundReportAttestation[],
  phase: "draft" | "final",
) {
  const admitted = new Set(attestations.map((report) => report.agent))
  const required = requiredReports(action).filter((agent) =>
    phase === "draft" ? !FUND_DRAFT_REVIEWERS.includes(agent as (typeof FUND_DRAFT_REVIEWERS)[number]) : true,
  )
  for (const role of required) {
    if (!admitted.has(role)) {
      throw new FundCaseStoreError({
        code: "required_specialist_missing",
        message: `${role} is required before ${phase === "draft" ? "recording the material draft" : "finalizing the proposal"}.`,
      })
    }
  }
}

export async function createDraft(
  input: {
    managerSessionID: string
    triggerMessageID?: string
    body: FundProposalBody
  },
  database?: Database.Interface,
): Promise<FundActionDraft> {
  const caseRecord = await caseForManagerTurn(input.managerSessionID, input.triggerMessageID, database)
  if (!caseRecord) {
    throw new FundCaseStoreError({ code: "case_not_admitted", message: "No immutable fund case is active." })
  }
  const policy = FUND_ACTION_POLICY[input.body.action]
  if (policy.riskTier !== "material_change") {
    throw new FundCaseStoreError({
      code: "draft_mismatch",
      message: "Only material-change actions use a pre-review draft.",
    })
  }
  assertSnapshotKinds(input.body)
  assertEvidencePartition(input.body)
  assertEvidence(caseRecord, [
    ...(input.body.portfolioSnapshot ? [input.body.portfolioSnapshot] : []),
    ...(input.body.marketSnapshot ? [input.body.marketSnapshot] : []),
    ...input.body.evidence,
    ...input.body.contraryEvidence,
  ])
  const attestations = await admitCompletedReports(caseRecord, input.body.specialistReports, database)
  validateRequiredReports(input.body.action, attestations, "draft")
  const body = {
    ...input.body,
    specialistReports: [...input.body.specialistReports],
    evidence: canonicalEvidence(input.body.evidence),
    contraryEvidence: canonicalEvidence(input.body.contraryEvidence),
    draftSha256: undefined,
  }
  const createdAt = Date.now()
  const draftBinding = {
    caseId: caseRecord.caseId,
    eventId: caseRecord.eventId,
    eventSha256: caseRecord.eventSha256,
    body,
    riskTier: policy.riskTier,
    humanApprovalRequired: approvalRequired(policy.riskTier),
  }
  const draftSha256 = fundCaseSha256(draftBinding)
  const draft: FundActionDraft = {
    ...body,
    caseId: caseRecord.caseId,
    eventId: caseRecord.eventId,
    eventType: caseRecord.eventType,
    draftSha256,
    riskTier: policy.riskTier,
    humanApprovalRequired: approvalRequired(policy.riskTier),
    createdAt,
  }
  return run(database, (service) =>
    withStore(
      service,
      service.db.transaction((tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(FundCaseDraftTable)
            .where(eq(FundCaseDraftTable.case_id, caseRecord.caseId))
            .get()
          if (existing) {
            if (existing.draft_sha256 !== draftSha256) {
              return yield* new FundCaseStoreError({
                code: "draft_mismatch",
                message: "A different immutable material draft is already bound to this case.",
              })
            }
            return {
              ...(JSON.parse(existing.payload_json) as FundActionDraft),
              draftSha256: existing.draft_sha256,
              createdAt: existing.time_created,
            }
          }
          yield* tx
            .insert(FundCaseDraftTable)
            .values({
              draft_id: opaque("fund_draft", { caseId: caseRecord.caseId, draftSha256 }),
              case_id: caseRecord.caseId,
              event_id: caseRecord.eventId,
              action: input.body.action,
              payload_json: stable(draft),
              draft_sha256: draftSha256,
              risk_tier: policy.riskTier,
              human_approval_required: approvalRequired(policy.riskTier),
              time_created: createdAt,
            })
            .run()
          return draft
        }),
      ),
    ),
  )
}

export async function finalizeProposal(
  input: {
    managerSessionID: string
    triggerMessageID?: string
    body: FundProposalBody
  },
  database?: Database.Interface,
): Promise<FundActionProposal> {
  const caseRecord = await caseForManagerTurn(input.managerSessionID, input.triggerMessageID, database)
  if (!caseRecord) {
    throw new FundCaseStoreError({ code: "case_not_admitted", message: "No immutable fund case is active." })
  }
  const policy = FUND_ACTION_POLICY[input.body.action]
  assertSnapshotKinds(input.body)
  assertEvidencePartition(input.body)
  assertEvidence(caseRecord, [
    ...(input.body.portfolioSnapshot ? [input.body.portfolioSnapshot] : []),
    ...(input.body.marketSnapshot ? [input.body.marketSnapshot] : []),
    ...input.body.evidence,
    ...input.body.contraryEvidence,
  ])
  const attestations = await admitCompletedReports(caseRecord, input.body.specialistReports, database)
  validateRequiredReports(input.body.action, attestations, "final")
  let draft: typeof FundCaseDraftTable.$inferSelect | undefined
  if (policy.riskTier === "material_change") {
    draft = await run(database, (service) =>
      withStore(
        service,
        service.db
          .select()
          .from(FundCaseDraftTable)
          .where(eq(FundCaseDraftTable.case_id, caseRecord.caseId))
          .get()
          .pipe(Effect.orDie),
      ),
    )
    if (!draft || input.body.draftSha256 !== draft.draft_sha256) {
      throw new FundCaseStoreError({
        code: "draft_required",
        message:
          "The final material proposal must reference the exact durable draft reviewed by validator and sentinel.",
      })
    }
    const reviewerReports = attestations.filter((report) =>
      FUND_DRAFT_REVIEWERS.includes(report.agent as (typeof FUND_DRAFT_REVIEWERS)[number]),
    )
    if (reviewerReports.some((report) => report.draftSha256 !== draft!.draft_sha256)) {
      throw new FundCaseStoreError({
        code: "draft_mismatch",
        message: "Validator and sentinel attestations must be bound to the exact material draft digest.",
      })
    }
    const storedDraft = JSON.parse(draft.payload_json) as FundActionDraft
    const immutableBody = {
      action: input.body.action,
      strategy: input.body.strategy,
      portfolioSnapshot: input.body.portfolioSnapshot,
      marketSnapshot: input.body.marketSnapshot,
      rationale: input.body.rationale,
      confidence: input.body.confidence,
      evidence: canonicalEvidence(input.body.evidence),
      contraryEvidence: canonicalEvidence(input.body.contraryEvidence),
    }
    const immutableDraft = {
      action: storedDraft.action,
      strategy: storedDraft.strategy,
      portfolioSnapshot: storedDraft.portfolioSnapshot,
      marketSnapshot: storedDraft.marketSnapshot,
      rationale: storedDraft.rationale,
      confidence: storedDraft.confidence,
      evidence: canonicalEvidence(storedDraft.evidence),
      contraryEvidence: canonicalEvidence(storedDraft.contraryEvidence),
    }
    if (fundCaseSha256(immutableBody) !== fundCaseSha256(immutableDraft)) {
      throw new FundCaseStoreError({
        code: "draft_mismatch",
        message:
          "Material action, strategy, snapshots, rationale, confidence, and evidence cannot change after review.",
      })
    }
  } else if (input.body.draftSha256 !== undefined) {
    throw new FundCaseStoreError({
      code: "draft_mismatch",
      message: "Non-material proposals cannot attach a material draft.",
    })
  }

  const proposedAtMs = Date.now()
  const proposedAt = new Date(proposedAtMs).toISOString()
  const canonicalBody = {
    ...input.body,
    specialistReports: [...input.body.specialistReports],
    evidence: canonicalEvidence(input.body.evidence),
    contraryEvidence: canonicalEvidence(input.body.contraryEvidence),
  }
  const proposalBinding = {
    caseId: caseRecord.caseId,
    eventId: caseRecord.eventId,
    eventSha256: caseRecord.eventSha256,
    body: canonicalBody,
    riskTier: policy.riskTier,
    humanApprovalRequired: approvalRequired(policy.riskTier),
    executionAuthorized: false,
    gatewayReview:
      input.body.action === "no_change" || input.body.action === "request_analysis"
        ? ("not_executable" as const)
        : ("required" as const),
    openPositionPolicy: "preserve_existing" as const,
  }
  const proposalSha256 = fundCaseSha256(proposalBinding)
  const idempotencyKey = opaque("fund_proposal", {
    caseId: caseRecord.caseId,
    eventId: caseRecord.eventId,
    proposalSha256,
  })
  const proposal: FundActionProposal = {
    ...canonicalBody,
    caseId: caseRecord.caseId,
    eventId: caseRecord.eventId,
    eventType: caseRecord.eventType,
    proposedAt,
    idempotencyKey,
    proposalSha256,
    executionAuthorized: false,
    gatewayReview: proposalBinding.gatewayReview,
    humanApprovalRequired: approvalRequired(policy.riskTier),
    riskTier: policy.riskTier,
    openPositionPolicy: "preserve_existing",
  }

  return run(database, (service) =>
    withStore(
      service,
      service.db.transaction((tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(FundCaseProposalTable)
            .where(eq(FundCaseProposalTable.case_id, caseRecord.caseId))
            .get()
          if (existing) {
            if (existing.proposal_sha256 !== proposalSha256) {
              return yield* new FundCaseStoreError({
                code: "proposal_already_finalized",
                message: "This case and event already has a different immutable final proposal.",
              })
            }
            return JSON.parse(existing.payload_json) as FundActionProposal
          }
          yield* tx
            .insert(FundCaseProposalTable)
            .values({
              proposal_id: opaque("fund_proposal_record", {
                caseId: caseRecord.caseId,
                proposalSha256,
              }),
              case_id: caseRecord.caseId,
              event_id: caseRecord.eventId,
              action: input.body.action,
              payload_json: stable(proposal),
              proposal_sha256: proposalSha256,
              idempotency_key: idempotencyKey,
              risk_tier: policy.riskTier,
              human_approval_required: approvalRequired(policy.riskTier),
              gateway_review: proposal.gatewayReview,
              execution_authorized: false,
              time_created: proposedAtMs,
            })
            .run()
          return proposal
        }),
      ),
    ),
  )
}

export async function proposalForCase(
  caseId: string,
  database?: Database.Interface,
): Promise<FundActionProposal | undefined> {
  return run(database, (service) =>
    withStore(
      service,
      service.db
        .select({ payload: FundCaseProposalTable.payload_json })
        .from(FundCaseProposalTable)
        .where(eq(FundCaseProposalTable.case_id, caseId))
        .get()
        .pipe(
          Effect.map((row) => (row ? (JSON.parse(row.payload) as FundActionProposal) : undefined)),
          Effect.orDie,
        ),
    ),
  )
}
