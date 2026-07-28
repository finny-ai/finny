import crypto from "node:crypto"
import { expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import {
  FundCaseProposalTable,
  FundCaseReportAdmissionTable,
  FundCaseTable,
} from "@opencode-ai/core/fund/case.sql"
import { Effect } from "effect"
import { count, eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { TaskState } from "@/task/state"
import {
  FundCaseStore,
  FundCaseStoreError,
  fundCaseSha256,
  type FundEvidenceReference,
  type FundProposalBody,
} from "@/fund/case-store"
import type { FundSpecialistAgent } from "@/agent/fund-policy"

const it = testEffect(Database.defaultLayer)
const hash = (value: string) => fundCaseSha256(value)

function setupSession(
  db: Database.Interface["db"],
  input: {
    projectID: string
    id: string
    agent: string
    parentID?: string
  },
) {
  return db
    .insert(SessionTable)
    .values({
      id: input.id as (typeof SessionTable.$inferInsert)["id"],
      project_id: input.projectID as (typeof ProjectTable.$inferInsert)["id"],
      parent_id: input.parentID as (typeof SessionTable.$inferInsert)["parent_id"],
      slug: input.id,
      directory: `/tmp/${input.projectID}` as (typeof SessionTable.$inferInsert)["directory"],
      title: input.id,
      version: "1",
      agent: input.agent,
    })
    .run()
    .pipe(Effect.asVoid, Effect.orDie)
}

function evidence(suffix: string): {
  portfolio: FundEvidenceReference
  market: FundEvidenceReference
  event: FundEvidenceReference
  all: FundEvidenceReference[]
} {
  const portfolio = { kind: "portfolio_snapshot" as const, ref: `portfolio-${suffix}`, sha256: hash(`p-${suffix}`) }
  const market = { kind: "market_snapshot" as const, ref: `market-${suffix}`, sha256: hash(`m-${suffix}`) }
  const event = { kind: "fund_event" as const, ref: `event-${suffix}`, sha256: hash(`e-${suffix}`) }
  return { portfolio, market, event, all: [portfolio, market, event] }
}

it.live("binds case, child, report, and final proposal provenance append-only", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const projectID = `project_fund_${suffix}`
    const managerID = `ses_fund_manager_${suffix}`
    const triggerID = `msg_fund_trigger_${suffix}`
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    yield* db.insert(ProjectTable).values({
      id: projectID as (typeof ProjectTable.$inferInsert)["id"],
      worktree: `/tmp/${projectID}` as (typeof ProjectTable.$inferInsert)["worktree"],
      sandboxes: [],
    })
    yield* setupSession(db, { projectID, id: managerID, agent: "fund_manager" })
    const refs = evidence(suffix)
    const caseRecord = yield* Effect.promise(() =>
      FundCaseStore.admitCase(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          envelope: {
            eventType: "regime_changed",
            sourceEventRef: `provider-event-${suffix}`,
            payloadSha256: hash(`payload-${suffix}`),
            occurredAt: "2026-07-27T18:00:00Z",
            evidence: refs.all,
          },
        },
        database,
      ),
    )
    const replay = yield* Effect.promise(() =>
      FundCaseStore.admitCase(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          envelope: {
            eventType: "regime_changed",
            sourceEventRef: `provider-event-${suffix}`,
            payloadSha256: hash(`payload-${suffix}`),
            occurredAt: "2026-07-27T18:00:00Z",
            evidence: refs.all,
          },
        },
        database,
      ),
    )
    expect(replay).toEqual(caseRecord)
    expect(caseRecord.caseId).toStartWith("case_")
    expect(caseRecord.eventId).toStartWith("evt_")
    expect(
      yield* Effect.promise(() =>
        FundCaseStore.specialistLaunchStatus(
          {
            managerSessionID: managerID,
            triggerMessageID: `${triggerID}_unknown`,
            agent: "fund_risk_analyst",
          },
          database,
        ),
      ),
    ).toMatchObject({ allowed: false, code: "case_not_admitted" })

    const makeChild = (agent: FundSpecialistAgent, index: number) =>
      Effect.gen(function* () {
        const childID = `ses_${agent}_${index}_${suffix}`
        yield* setupSession(db, { projectID, id: childID, agent, parentID: managerID })
        yield* Effect.promise(() =>
          TaskState.upsert(
            {
              id: childID as Parameters<typeof TaskState.upsert>[0]["id"],
              parentSessionID: managerID as Parameters<typeof TaskState.upsert>[0]["parentSessionID"],
              description: `${agent} review`,
              subagentType: agent,
              mode: "foreground",
              status: TaskState.Status.running,
              startedAt: Date.now(),
            },
            database,
          ),
        )
        yield* Effect.promise(() =>
          FundCaseStore.admitChildAttempt(
            {
              managerSessionID: managerID,
              triggerMessageID: triggerID,
              childSessionID: childID,
              agent,
            },
            database,
          ),
        )
        return childID
      })

    const submit = (agent: FundSpecialistAgent, childID: string) =>
      Effect.promise(() =>
        FundCaseStore.submitReport(
          {
            managerSessionID: managerID,
            specialistSessionID: childID,
            agent,
            report: {
              subject: `${agent} finding`,
              summary: `${agent} found evidence supporting a bounded entry pause.`,
              recommendation: "propose_pause",
              confidence: 0.8,
              evidence: [refs.event],
              riskFlags: ["position_risk"],
            },
          },
          database,
        ),
      )

    const riskChild = yield* makeChild("fund_risk_analyst", 1)
    const sentinelChild = yield* makeChild("fund_risk_sentinel", 1)
    const riskReport = yield* submit("fund_risk_analyst", riskChild)
    const sentinelReport = yield* submit("fund_risk_sentinel", sentinelChild)

    const body: FundProposalBody = {
      action: "propose_pause",
      strategy: {
        strategyId: `strategy-${suffix}`,
        version: 2,
        codeSha256: hash(`code-${suffix}`),
        configSha256: hash(`config-${suffix}`),
      },
      portfolioSnapshot: refs.portfolio,
      marketSnapshot: refs.market,
      rationale: "Pause future entries while the external gateway reviews the regime mismatch.",
      confidence: 0.82,
      specialistReports: [
        { agent: "fund_risk_analyst", reportSha256: riskReport.reportSha256 },
        { agent: "fund_risk_sentinel", reportSha256: sentinelReport.reportSha256 },
      ],
      evidence: refs.all,
      contraryEvidence: [],
    }

    const premature = yield* Effect.promise(() =>
      FundCaseStore.finalizeProposal(
        { managerSessionID: managerID, triggerMessageID: triggerID, body },
        database,
      ).catch((error) => error),
    )
    expect(premature).toBeInstanceOf(FundCaseStoreError)
    expect((premature as FundCaseStoreError).code).toBe("report_not_completed")

    yield* Effect.promise(() =>
      Promise.all([
        TaskState.finalizeActive(
          riskChild,
          { status: TaskState.Status.completed, resultSummary: "report submitted" },
          database,
        ),
        TaskState.finalizeActive(
          sentinelChild,
          { status: TaskState.Status.completed, resultSummary: "report submitted" },
          database,
        ),
      ]),
    )
    const proposal = yield* Effect.promise(() =>
      FundCaseStore.finalizeProposal(
        { managerSessionID: managerID, triggerMessageID: triggerID, body },
        database,
      ),
    )
    expect(proposal).toMatchObject({
      caseId: caseRecord.caseId,
      eventId: caseRecord.eventId,
      action: "propose_pause",
      riskTier: "bounded_paper",
      humanApprovalRequired: false,
      executionAuthorized: false,
      gatewayReview: "required",
      openPositionPolicy: "preserve_existing",
    })
    expect(proposal.idempotencyKey).toStartWith("fund_proposal_")
    expect(proposal.proposedAt).toEndWith("Z")
    expect(
      yield* Effect.promise(() =>
        FundCaseStore.finalizeProposal(
          { managerSessionID: managerID, triggerMessageID: triggerID, body },
          database,
        ),
      ),
    ).toEqual(proposal)

    const changed = yield* Effect.promise(() =>
      FundCaseStore.finalizeProposal(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          body: { ...body, rationale: "A different post-final rationale must never replace the ledger." },
        },
        database,
      ).catch((error) => error),
    )
    expect((changed as FundCaseStoreError).code).toBe("proposal_already_finalized")

    const admissionCount = yield* db.select({ count: count() }).from(FundCaseReportAdmissionTable).get()
    expect(admissionCount?.count).toBeGreaterThanOrEqual(2)
    const stored = yield* db
      .select()
      .from(FundCaseProposalTable)
      .where(eq(FundCaseProposalTable.case_id, caseRecord.caseId))
      .get()
    expect(stored?.execution_authorized).toBe(false)

    const updateAttempt = yield* db
      .update(FundCaseProposalTable)
      .set({ execution_authorized: true })
      .where(eq(FundCaseProposalTable.case_id, caseRecord.caseId))
      .run()
      .pipe(Effect.exit)
    expect(updateAttempt._tag).toBe("Failure")
  }),
)

it.live("enforces two attempts, exact TaskState lineage, draft-bound reviewers, and cross-case replay rejection", () =>
  Effect.gen(function* () {
    const suffix = crypto.randomUUID()
    const projectID = `project_fund_material_${suffix}`
    const managerID = `ses_fund_material_${suffix}`
    const triggerID = `msg_fund_material_${suffix}`
    const { db } = yield* Database.Service
    const database = yield* Database.Service
    yield* db.insert(ProjectTable).values({
      id: projectID as (typeof ProjectTable.$inferInsert)["id"],
      worktree: `/tmp/${projectID}` as (typeof ProjectTable.$inferInsert)["worktree"],
      sandboxes: [],
    })
    yield* setupSession(db, { projectID, id: managerID, agent: "fund_manager" })
    const refs = evidence(suffix)
    const caseRecord = yield* Effect.promise(() =>
      FundCaseStore.admitCase(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          envelope: {
            eventType: "strategy_health_changed",
            sourceEventRef: `health-${suffix}`,
            payloadSha256: hash(`health-payload-${suffix}`),
            evidence: refs.all,
          },
        },
        database,
      ),
    )

    const createChild = (agent: FundSpecialistAgent, index: number, parentID = managerID) =>
      Effect.gen(function* () {
        const childID = `ses_material_${agent}_${index}_${suffix}`
        yield* setupSession(db, { projectID, id: childID, agent, parentID })
        yield* Effect.promise(() =>
          TaskState.upsert(
            {
              id: childID as Parameters<typeof TaskState.upsert>[0]["id"],
              parentSessionID: parentID as Parameters<typeof TaskState.upsert>[0]["parentSessionID"],
              description: `${agent} material review`,
              subagentType: agent,
              mode: "foreground",
              status: TaskState.Status.running,
              startedAt: Date.now(),
            },
            database,
          ),
        )
        return childID
      })

    const codeChild = yield* createChild("fund_code_change_agent", 1)
    yield* Effect.promise(() =>
      FundCaseStore.admitChildAttempt(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          childSessionID: codeChild,
          agent: "fund_code_change_agent",
        },
        database,
      ),
    )
    const codeReport = yield* Effect.promise(() =>
      FundCaseStore.submitReport(
        {
          managerSessionID: managerID,
          specialistSessionID: codeChild,
          agent: "fund_code_change_agent",
          report: {
            subject: "Logic mismatch",
            summary: "A bounded signal-logic change should be independently reviewed before activation.",
            recommendation: "propose_logic_review",
            confidence: 0.78,
            evidence: refs.all,
            riskFlags: ["strategy_mismatch"],
          },
        },
        database,
      ),
    )
    yield* Effect.promise(() =>
      TaskState.finalizeActive(
        codeChild,
        { status: TaskState.Status.completed, resultSummary: "report submitted" },
        database,
      ),
    )

    const materialBody: FundProposalBody = {
      action: "propose_logic_change",
      strategy: {
        strategyId: `strategy-${suffix}`,
        version: 3,
        codeSha256: hash(`code-${suffix}`),
        configSha256: hash(`config-${suffix}`),
      },
      portfolioSnapshot: refs.portfolio,
      marketSnapshot: refs.market,
      rationale: "Change the future-entry filter while preserving every position under its opening version.",
      confidence: 0.78,
      specialistReports: [{ agent: "fund_code_change_agent", reportSha256: codeReport.reportSha256 }],
      evidence: refs.all,
      contraryEvidence: [],
    }
    const draft = yield* Effect.promise(() =>
      FundCaseStore.createDraft(
        { managerSessionID: managerID, triggerMessageID: triggerID, body: materialBody },
        database,
      ),
    )
    expect(draft).toMatchObject({
      caseId: caseRecord.caseId,
      riskTier: "material_change",
      humanApprovalRequired: true,
    })

    const review = (
      agent: "fund_independent_validator" | "fund_risk_sentinel",
      index: number,
    ) =>
      Effect.gen(function* () {
        const childID = yield* createChild(agent, index)
        const admitted = yield* Effect.promise(() =>
          FundCaseStore.admitChildAttempt(
            { managerSessionID: managerID, triggerMessageID: triggerID, childSessionID: childID, agent },
            database,
          ),
        )
        expect(admitted.draftSha256).toBe(draft.draftSha256)
        const context = yield* Effect.promise(() => FundCaseStore.childContext(childID, database))
        expect(context).toContain(draft.draftSha256)
        const report = yield* Effect.promise(() =>
          FundCaseStore.submitReport(
            {
              managerSessionID: managerID,
              specialistSessionID: childID,
              agent,
              report: {
                subject: `${agent} draft review`,
                summary: `${agent} reviewed the exact immutable draft and found no policy bypass.`,
                recommendation: "propose_logic_review",
                confidence: 0.76,
                evidence: refs.all,
                riskFlags: ["strategy_mismatch"],
              },
            },
            database,
          ),
        )
        yield* Effect.promise(() =>
          TaskState.finalizeActive(
            childID,
            { status: TaskState.Status.completed, resultSummary: "draft-bound report submitted" },
            database,
          ),
        )
        return report
      })
    const validator = yield* review("fund_independent_validator", 1)
    const sentinel = yield* review("fund_risk_sentinel", 1)
    const finalBody: FundProposalBody = {
      ...materialBody,
      specialistReports: [
        ...materialBody.specialistReports,
        { agent: "fund_independent_validator", reportSha256: validator.reportSha256 },
        { agent: "fund_risk_sentinel", reportSha256: sentinel.reportSha256 },
      ],
      draftSha256: draft.draftSha256,
    }
    const changedDraft = yield* Effect.promise(() =>
      FundCaseStore.finalizeProposal(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          body: { ...finalBody, rationale: "A changed rationale after review." },
        },
        database,
      ).catch((error) => error),
    )
    expect((changedDraft as FundCaseStoreError).code).toBe("draft_mismatch")
    const final = yield* Effect.promise(() =>
      FundCaseStore.finalizeProposal(
        { managerSessionID: managerID, triggerMessageID: triggerID, body: finalBody },
        database,
      ),
    )
    expect(final).toMatchObject({
      riskTier: "material_change",
      humanApprovalRequired: true,
      executionAuthorized: false,
      draftSha256: draft.draftSha256,
    })

    const wrongParent = `ses_wrong_parent_${suffix}`
    yield* setupSession(db, { projectID, id: wrongParent, agent: "fund_manager" })
    const badChild = yield* createChild("fund_regime_analyst", 1, wrongParent)
    const lineageError = yield* Effect.promise(() =>
      FundCaseStore.admitChildAttempt(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          childSessionID: badChild,
          agent: "fund_regime_analyst",
        },
        database,
      ).catch((error) => error),
    )
    expect((lineageError as FundCaseStoreError).code).toBe("invalid_lineage")

    const firstRetry = yield* createChild("fund_regime_analyst", 2)
    yield* Effect.promise(() =>
      FundCaseStore.admitChildAttempt(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          childSessionID: firstRetry,
          agent: "fund_regime_analyst",
        },
        database,
      ),
    )
    yield* Effect.promise(() =>
      TaskState.finalizeActive(firstRetry, { status: TaskState.Status.failed, lastError: "provider error" }, database),
    )
    const secondRetry = yield* createChild("fund_regime_analyst", 3)
    yield* Effect.promise(() =>
      FundCaseStore.admitChildAttempt(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          childSessionID: secondRetry,
          agent: "fund_regime_analyst",
        },
        database,
      ),
    )
    yield* Effect.promise(() =>
      TaskState.finalizeActive(secondRetry, { status: TaskState.Status.failed, lastError: "provider error" }, database),
    )
    const thirdRetry = yield* createChild("fund_regime_analyst", 4)
    const budget = yield* Effect.promise(() =>
      FundCaseStore.admitChildAttempt(
        {
          managerSessionID: managerID,
          triggerMessageID: triggerID,
          childSessionID: thirdRetry,
          agent: "fund_regime_analyst",
        },
        database,
      ).catch((error) => error),
    )
    expect((budget as FundCaseStoreError).code).toBe("attempt_budget_exhausted")

    const crossCase = yield* Effect.promise(() =>
      FundCaseStore.admitCase(
        {
          managerSessionID: managerID,
          triggerMessageID: `msg_second_${suffix}`,
          envelope: {
            eventType: "scheduled_review",
            sourceEventRef: `second-${suffix}`,
            payloadSha256: hash(`second-${suffix}`),
            evidence: evidence(`second-${suffix}`).all,
          },
        },
        database,
      ),
    )
    const replayError = yield* Effect.promise(() =>
      FundCaseStore.finalizeProposal(
        {
          managerSessionID: managerID,
          triggerMessageID: crossCase.triggerMessageID,
          body: {
            action: "request_analysis",
            rationale: "Attempt to replay a report and evidence from another case.",
            confidence: 0.4,
            specialistReports: [{ agent: "fund_code_change_agent", reportSha256: codeReport.reportSha256 }],
            evidence: refs.all,
            contraryEvidence: [],
          },
        },
        database,
      ).catch((error) => error),
    )
    expect(["evidence_mismatch", "report_missing"]).toContain((replayError as FundCaseStoreError).code)

    const row = yield* db
      .select()
      .from(FundCaseTable)
      .where(eq(FundCaseTable.case_id, caseRecord.caseId))
      .get()
    expect(row?.manager_session_id).toBe(managerID)
  }),
)
