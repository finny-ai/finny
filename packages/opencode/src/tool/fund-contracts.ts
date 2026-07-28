import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import z from "zod"
import {
  FUND_ACTION_POLICY,
  FUND_ACTION_TYPES,
  FUND_DRAFT_REVIEWERS,
  FUND_MANAGER_AGENT,
  FUND_SPECIALIST_AGENTS,
  isFundManagerAgent,
  isFundSpecialistAgent,
  type FundActionType as PolicyFundActionType,
} from "@/agent/fund-policy"
import {
  FundCaseStore,
  FundCaseStoreError,
  type FundActionDraft,
  type FundActionProposal,
  type FundEvidenceReference as StoredFundEvidenceReference,
  type FundProposalBody,
  type FundReportSubmissionInput,
} from "@/fund/case-store"
import { MessageV2 } from "@/session/message-v2"
import { Tool } from "./tool"

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?key|token|secret|password|database[_-]?url|railway[_-]?token|telegram[_-]?token|broker[_-]?credentials?)\s*[:=]\s*\S+/i
const CREDENTIAL_URI_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const TELEGRAM_BOT_TOKEN_PATTERN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/

const credentialFreeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !containsCredentialMaterial(value), "must not contain credential material")

export const FundOpaqueID = z.string().regex(OPAQUE_ID_PATTERN)
export const FundSha256 = z.string().regex(SHA256_PATTERN)

export const FundEventType = z.enum([
  "order_filled",
  "order_cancelled",
  "regime_changed",
  "strategy_health_changed",
  "risk_limit_changed",
  "deployment_result",
  "scheduled_review",
  "operator_request",
])

export const FundEvidenceReference = z
  .object({
    kind: z.enum([
      "fund_event",
      "market_snapshot",
      "portfolio_snapshot",
      "position_snapshot",
      "strategy_version",
      "regime_observation",
      "fill",
      "backtest_run",
      "review_packet",
      "specialist_report",
      "fund_policy",
      "news_context",
    ]),
    ref: FundOpaqueID,
    sha256: FundSha256,
  })
  .strict()

export const FundCaseEnvelopeParameters = z
  .object({
    eventType: FundEventType,
    sourceEventRef: FundOpaqueID,
    payloadSha256: FundSha256,
    occurredAt: z.string().datetime({ offset: true }).optional(),
    evidence: z.array(FundEvidenceReference).min(1).max(64),
  })
  .strict()

export const FundStrategyReference = z
  .object({
    strategyId: FundOpaqueID,
    version: z.number().int().positive(),
    codeSha256: FundSha256,
    configSha256: FundSha256,
  })
  .strict()

export const FundSpecialistReportReference = z
  .object({
    agent: z.enum(FUND_SPECIALIST_AGENTS),
    reportSha256: FundSha256,
  })
  .strict()

export const FundSpecialistReportParameters = z
  .object({
    subject: credentialFreeText(240),
    summary: credentialFreeText(2_000),
    recommendation: z.enum([
      "no_change",
      "investigate",
      "propose_pause",
      "propose_resume",
      "propose_strategy_build",
      "propose_strategy_deploy",
      "propose_strategy_rollback",
      "propose_logic_review",
      "propose_paper_allocation_change",
      "escalate_human",
    ]),
    confidence: z.number().min(0).max(1),
    evidence: z.array(FundEvidenceReference).min(1).max(32),
    riskFlags: z
      .array(
        z.enum([
          "data_quality",
          "market_mismatch",
          "strategy_mismatch",
          "position_risk",
          "execution_anomaly",
          "model_uncertainty",
        ]),
      )
      .max(12),
  })
  .strict()

export const FundActionType = z.enum(FUND_ACTION_TYPES)

const FundProposalBodyBase = z
  .object({
    action: FundActionType,
    strategy: FundStrategyReference.optional(),
    portfolioSnapshot: FundEvidenceReference.optional(),
    marketSnapshot: FundEvidenceReference.optional(),
    rationale: credentialFreeText(2_000),
    confidence: z.number().min(0).max(1),
    specialistReports: z.array(FundSpecialistReportReference).max(FUND_SPECIALIST_AGENTS.length),
    evidence: z.array(FundEvidenceReference).min(1).max(32),
    contraryEvidence: z.array(FundEvidenceReference).max(16),
    draftSha256: FundSha256.optional(),
  })
  .strict()

function validateProposalShape(
  value: z.infer<typeof FundProposalBodyBase>,
  ctx: z.RefinementCtx,
  phase: "draft" | "final",
) {
  const snapshotOptional = value.action === "request_analysis" || value.action === "propose_strategy_build"
  if (!snapshotOptional && value.portfolioSnapshot?.kind !== "portfolio_snapshot") {
    ctx.addIssue({
      code: "custom",
      path: ["portfolioSnapshot"],
      message: "a portfolio_snapshot bound to the active case is required",
    })
  }
  if (!snapshotOptional && value.marketSnapshot?.kind !== "market_snapshot") {
    ctx.addIssue({
      code: "custom",
      path: ["marketSnapshot"],
      message: "a market_snapshot bound to the active case is required",
    })
  }
  if (value.portfolioSnapshot && value.portfolioSnapshot.kind !== "portfolio_snapshot") {
    ctx.addIssue({ code: "custom", path: ["portfolioSnapshot", "kind"], message: "must be portfolio_snapshot" })
  }
  if (value.marketSnapshot && value.marketSnapshot.kind !== "market_snapshot") {
    ctx.addIssue({ code: "custom", path: ["marketSnapshot", "kind"], message: "must be market_snapshot" })
  }
  const mutating = value.action !== "no_change" && value.action !== "request_analysis"
  if (mutating && value.action !== "propose_strategy_build" && !value.strategy) {
    ctx.addIssue({ code: "custom", path: ["strategy"], message: "is required for this action" })
  }
  const uniqueRoles = new Set(value.specialistReports.map((report) => report.agent))
  if (uniqueRoles.size !== value.specialistReports.length) {
    ctx.addIssue({
      code: "custom",
      path: ["specialistReports"],
      message: "must contain at most one report per specialist",
    })
  }
  const policy = FUND_ACTION_POLICY[value.action]
  const required = policy.requiredSpecialists.filter((agent) =>
    phase === "draft"
      ? !FUND_DRAFT_REVIEWERS.includes(agent as (typeof FUND_DRAFT_REVIEWERS)[number])
      : true,
  )
  for (const agent of required) {
    if (!uniqueRoles.has(agent)) {
      ctx.addIssue({
        code: "custom",
        path: ["specialistReports"],
        message: `${agent} is required for ${value.action}`,
      })
    }
  }
  if (phase === "draft") {
    if (policy.riskTier !== "material_change") {
      ctx.addIssue({ code: "custom", path: ["action"], message: "only material changes use a review draft" })
    }
    if (value.draftSha256 !== undefined) {
      ctx.addIssue({ code: "custom", path: ["draftSha256"], message: "is server-derived and must be omitted" })
    }
  } else if (policy.riskTier === "material_change" && !value.draftSha256) {
    ctx.addIssue({
      code: "custom",
      path: ["draftSha256"],
      message: "the exact server-issued material draft digest is required",
    })
  } else if (policy.riskTier !== "material_change" && value.draftSha256 !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["draftSha256"],
      message: "must be omitted for a non-material proposal",
    })
  }
}

export const FundActionDraftParameters = FundProposalBodyBase.superRefine((value, ctx) =>
  validateProposalShape(value, ctx, "draft"),
)

export const FundActionProposalParameters = FundProposalBodyBase.superRefine((value, ctx) =>
  validateProposalShape(value, ctx, "final"),
)

export type FundSpecialistReportInput = z.infer<typeof FundSpecialistReportParameters>
export type FundActionDraftInput = z.infer<typeof FundActionDraftParameters>
export type FundActionProposalInput = z.infer<typeof FundActionProposalParameters>

export type FundSpecialistReport = {
  caseId: string
  eventId: string
  eventType: z.infer<typeof FundEventType>
  specialist: string
  reportSha256: string
  submittedAt: number
  draftSha256?: string
  report: FundSpecialistReportInput
}

export { type FundActionDraft, type FundActionProposal }

export function containsCredentialMaterial(value: string): boolean {
  return (
    CREDENTIAL_ASSIGNMENT_PATTERN.test(value) ||
    CREDENTIAL_URI_PATTERN.test(value) ||
    TELEGRAM_BOT_TOKEN_PATTERN.test(value)
  )
}

function proposalBody(
  input: FundActionDraftInput | FundActionProposalInput,
): FundProposalBody {
  return {
    action: input.action as PolicyFundActionType,
    strategy: input.strategy,
    portfolioSnapshot: input.portfolioSnapshot as StoredFundEvidenceReference | undefined,
    marketSnapshot: input.marketSnapshot as StoredFundEvidenceReference | undefined,
    rationale: input.rationale,
    confidence: input.confidence,
    specialistReports: input.specialistReports,
    evidence: input.evidence,
    contraryEvidence: input.contraryEvidence,
    draftSha256: input.draftSha256,
  }
}

async function triggerMessageID(ctx: Tool.Context, database: Database.Interface): Promise<string | undefined> {
  const message = await Effect.runPromise(
    MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
      Effect.provideService(Database.Service, database),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
  )
  return message?.info.role === "assistant" ? message.info.parentID : undefined
}

type RejectionCode =
  | "unauthorized_agent"
  | "case_not_admitted"
  | "invalid_lineage"
  | "unverified_specialist_reports"
  | "draft_required"
  | "draft_mismatch"
  | "evidence_mismatch"
  | "attempt_budget_exhausted"
  | "specialist_active"
  | "specialist_completed"
  | "proposal_already_finalized"
  | "required_specialist_missing"
  | "report_not_completed"
  | "report_missing"
  | "report_already_submitted"
  | "duplicate_case"
  | "case_mismatch"

type SpecialistReportMetadata = {
  accepted: boolean
  report?: FundSpecialistReport
  code?: RejectionCode
}

type DraftMetadata = {
  accepted: boolean
  draft?: FundActionDraft
  code?: RejectionCode
}

type ActionProposalMetadata = {
  accepted: boolean
  proposal?: FundActionProposal
  code?: RejectionCode
}

function rejection(error: unknown): { code: RejectionCode; message: string } {
  if (error instanceof FundCaseStoreError) return { code: error.code, message: error.message }
  return {
    code: "invalid_lineage",
    message: error instanceof Error ? error.message : "Fund case verification failed closed.",
  }
}

export const FundSpecialistReportTool = Tool.define<
  typeof FundSpecialistReportParameters,
  SpecialistReportMetadata,
  Database.Service,
  "finny_fund_specialist_report"
>(
  "finny_fund_specialist_report",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description:
        "Submit one credential-free advisory finding from this admitted specialist child. Case, event, role, draft, timestamps, and report attestation are derived by the server. This grants no execution authority.",
      parameters: FundSpecialistReportParameters,
      execute: (input, ctx) =>
        Effect.promise(async () => {
          if (!isFundSpecialistAgent(ctx.agent) || !ctx.parentSessionID) {
            return {
              title: "Fund specialist report rejected",
              output: "Only a registered specialist child of a Fund Manager case may submit a report.",
              metadata: { accepted: false, code: "unauthorized_agent" } satisfies SpecialistReportMetadata,
            }
          }
          try {
            const stored = await FundCaseStore.submitReport(
              {
                managerSessionID: ctx.parentSessionID,
                specialistSessionID: ctx.sessionID,
                agent: ctx.agent,
                report: input satisfies FundReportSubmissionInput,
              },
              database,
            )
            const report: FundSpecialistReport = {
              ...stored,
              eventType: stored.eventType as z.infer<typeof FundEventType>,
            }
            return {
              title: "Fund specialist report submitted",
              output:
                `Advisory report ${report.reportSha256} was append-only submitted for ${report.caseId}. ` +
                "It becomes admissible only after this exact child TaskState completes and grants no execution authority.",
              metadata: { accepted: true, report } satisfies SpecialistReportMetadata,
            }
          } catch (error) {
            const issue = rejection(error)
            return {
              title: "Fund specialist report rejected",
              output: issue.message,
              metadata: { accepted: false, code: issue.code } satisfies SpecialistReportMetadata,
            }
          }
        }),
    }
  }),
)

export const FundActionDraftTool = Tool.define<
  typeof FundActionDraftParameters,
  DraftMetadata,
  Database.Service,
  "finny_fund_action_draft"
>(
  "finny_fund_action_draft",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description:
        "Record the immutable non-executable digest of a material proposed action before launching independent validator and risk-sentinel review. The draft cannot execute or authorize anything.",
      parameters: FundActionDraftParameters,
      execute: (input, ctx) =>
        Effect.promise(async () => {
          if (!isFundManagerAgent(ctx.agent)) {
            return {
              title: "Fund action draft rejected",
              output: `Only "${FUND_MANAGER_AGENT}" may record a fund action draft.`,
              metadata: { accepted: false, code: "unauthorized_agent" } satisfies DraftMetadata,
            }
          }
          try {
            const draft = await FundCaseStore.createDraft(
              {
                managerSessionID: ctx.sessionID,
                triggerMessageID: await triggerMessageID(ctx, database),
                body: proposalBody(input),
              },
              database,
            )
            return {
              title: "Fund action draft recorded",
              output:
                `Material draft ${draft.draftSha256} was append-only recorded. ` +
                "It is non-executable; validator and risk-sentinel children must review this exact digest.",
              metadata: { accepted: true, draft } satisfies DraftMetadata,
            }
          } catch (error) {
            const issue = rejection(error)
            return {
              title: "Fund action draft rejected",
              output: issue.message,
              metadata: { accepted: false, code: issue.code } satisfies DraftMetadata,
            }
          }
        }),
    }
  }),
)

export const FundActionProposalTool = Tool.define<
  typeof FundActionProposalParameters,
  ActionProposalMetadata,
  Database.Service,
  "finny_fund_action_propose"
>(
  "finny_fund_action_propose",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description:
        "Append exactly one credential-free final recommendation for the active immutable fund event. Case, event, risk, approval, time, and idempotency are derived by the server. Output is always non-executable.",
      parameters: FundActionProposalParameters,
      execute: (input, ctx) =>
        Effect.promise(async () => {
          if (!isFundManagerAgent(ctx.agent)) {
            return {
              title: "Fund action proposal rejected",
              output: `Only "${FUND_MANAGER_AGENT}" may submit a fund action proposal.`,
              metadata: { accepted: false, code: "unauthorized_agent" } satisfies ActionProposalMetadata,
            }
          }
          try {
            const proposal = await FundCaseStore.finalizeProposal(
              {
                managerSessionID: ctx.sessionID,
                triggerMessageID: await triggerMessageID(ctx, database),
                body: proposalBody(input),
              },
              database,
            )
            return {
              title: "Fund action proposal recorded",
              output:
                `Proposal ${proposal.proposalSha256} was append-only recorded for external policy-gateway review. ` +
                "executionAuthorized=false; no action, approval, deployment, or broker call occurred.",
              metadata: { accepted: true, proposal } satisfies ActionProposalMetadata,
            }
          } catch (error) {
            const issue = rejection(error)
            return {
              title: "Fund action proposal rejected",
              output: issue.message,
              metadata: { accepted: false, code: issue.code } satisfies ActionProposalMetadata,
            }
          }
        }),
    }
  }),
)
