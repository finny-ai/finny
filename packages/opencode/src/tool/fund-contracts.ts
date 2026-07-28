import crypto from "node:crypto"
import { Effect } from "effect"
import z from "zod"
import {
  FUND_ACTION_TYPES,
  FUND_MANAGER_AGENT,
  FUND_SPECIALIST_AGENTS,
  fundSpecialistRole,
  isFundManagerAgent,
  type FundSpecialistRole,
} from "@/agent/fund-policy"
import { Tool } from "./tool"

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
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
export const FundTimestamp = z.string().regex(ISO_TIMESTAMP_PATTERN)

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
    caseId: FundOpaqueID,
    eventId: FundOpaqueID,
    eventType: FundEventType,
    observedAt: FundTimestamp,
    subject: credentialFreeText(240),
    summary: credentialFreeText(2_000),
    recommendation: z.enum([
      "no_change",
      "investigate",
      "propose_pause",
      "propose_resume",
      "propose_logic_review",
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

export const FundActionProposalParameters = z
  .object({
    caseId: FundOpaqueID,
    eventId: FundOpaqueID,
    eventType: FundEventType,
    proposedAt: FundTimestamp,
    idempotencyKey: FundOpaqueID,
    action: FundActionType,
    strategy: FundStrategyReference.optional(),
    portfolioSnapshot: FundEvidenceReference,
    marketSnapshot: FundEvidenceReference,
    rationale: credentialFreeText(2_000),
    confidence: z.number().min(0).max(1),
    riskTier: z.enum(["observation", "bounded_paper", "material_change"]),
    specialistReports: z.array(FundSpecialistReportReference).max(FUND_SPECIALIST_AGENTS.length),
    evidence: z.array(FundEvidenceReference).min(1).max(32),
    contraryEvidence: z.array(FundEvidenceReference).max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    const advisoryOnly = value.action === "no_change" || value.action === "request_analysis"
    if (!advisoryOnly && value.action !== "propose_strategy_build" && value.strategy === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["strategy"],
        message: "is required for a strategy-mutating proposal",
      })
    }
    if (advisoryOnly && value.riskTier !== "observation") {
      ctx.addIssue({
        code: "custom",
        path: ["riskTier"],
        message: "must be observation for no_change or request_analysis",
      })
    }
    if (!advisoryOnly && value.riskTier === "observation") {
      ctx.addIssue({
        code: "custom",
        path: ["riskTier"],
        message: "must be bounded_paper or material_change for a state-change proposal",
      })
    }
    if (new Set(value.specialistReports.map((report) => report.agent)).size !== value.specialistReports.length) {
      ctx.addIssue({
        code: "custom",
        path: ["specialistReports"],
        message: "must contain at most one report per specialist",
      })
    }
    if (value.riskTier === "material_change") {
      const agents = new Set(value.specialistReports.map((report) => report.agent))
      for (const required of ["fund_independent_validator", "fund_risk_sentinel"] as const) {
        if (agents.has(required)) continue
        ctx.addIssue({
          code: "custom",
          path: ["specialistReports"],
          message: `${required} is required for a material change`,
        })
      }
    }
    if (value.portfolioSnapshot.kind !== "portfolio_snapshot") {
      ctx.addIssue({
        code: "custom",
        path: ["portfolioSnapshot", "kind"],
        message: "must be portfolio_snapshot",
      })
    }
    if (value.marketSnapshot.kind !== "market_snapshot") {
      ctx.addIssue({
        code: "custom",
        path: ["marketSnapshot", "kind"],
        message: "must be market_snapshot",
      })
    }
  })

export type FundSpecialistReportInput = z.infer<typeof FundSpecialistReportParameters>
export type FundActionProposalInput = z.infer<typeof FundActionProposalParameters>

export type FundSpecialistReport = FundSpecialistReportInput & {
  specialist: FundSpecialistRole
  reportSha256: string
}

export type FundActionProposal = FundActionProposalInput & {
  proposalSha256: string
  executionAuthorized: false
  gatewayReview: "not_executable" | "required"
  humanApprovalRequired: boolean
  openPositionPolicy: "preserve_existing"
}

export function containsCredentialMaterial(value: string): boolean {
  return (
    CREDENTIAL_ASSIGNMENT_PATTERN.test(value) ||
    CREDENTIAL_URI_PATTERN.test(value) ||
    TELEGRAM_BOT_TOKEN_PATTERN.test(value)
  )
}

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

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value)).digest("hex")
}

export function createFundSpecialistReport(
  agent: string,
  input: FundSpecialistReportInput,
): FundSpecialistReport | undefined {
  const specialist = fundSpecialistRole(agent)
  if (!specialist) return undefined
  const parsed = FundSpecialistReportParameters.parse(input)
  return {
    ...parsed,
    specialist,
    reportSha256: sha256({ specialist, report: parsed }),
  }
}

export function createFundActionProposal(
  agent: string,
  input: FundActionProposalInput,
): FundActionProposal | undefined {
  if (!isFundManagerAgent(agent)) return undefined
  const parsed = FundActionProposalParameters.parse(input)
  return {
    ...parsed,
    proposalSha256: sha256({ actor: FUND_MANAGER_AGENT, proposal: parsed }),
    executionAuthorized: false,
    gatewayReview:
      parsed.action === "no_change" || parsed.action === "request_analysis" ? "not_executable" : "required",
    humanApprovalRequired: parsed.riskTier === "material_change",
    openPositionPolicy: "preserve_existing",
  }
}

type SpecialistReportMetadata = {
  accepted: boolean
  report?: FundSpecialistReport
  code?: "unauthorized_agent"
}

type ActionProposalMetadata = {
  accepted: boolean
  proposal?: FundActionProposal
  code?: "unauthorized_agent"
}

export const FundSpecialistReportTool = Tool.define<
  typeof FundSpecialistReportParameters,
  SpecialistReportMetadata,
  never,
  "finny_fund_specialist_report"
>(
  "finny_fund_specialist_report",
  Effect.succeed({
    description:
      "Submit a credential-free advisory finding bound to immutable fund evidence references. This records no trades, deployments, approvals, or infrastructure changes.",
    parameters: FundSpecialistReportParameters,
    execute: (input, ctx) =>
      Effect.sync(() => {
        const report = createFundSpecialistReport(ctx.agent, input)
        if (!report) {
          return {
            title: "Fund specialist report rejected",
            output: "Only a registered Fund Manager specialist may submit this advisory report.",
            metadata: { accepted: false, code: "unauthorized_agent" } satisfies SpecialistReportMetadata,
          }
        }
        return {
          title: "Fund specialist report accepted",
          output: `Advisory report ${report.reportSha256} accepted for Fund Manager review. It grants no execution authority.`,
          metadata: { accepted: true, report } satisfies SpecialistReportMetadata,
        }
      }),
  }),
)

export const FundActionProposalTool = Tool.define<
  typeof FundActionProposalParameters,
  ActionProposalMetadata,
  never,
  "finny_fund_action_propose"
>(
  "finny_fund_action_propose",
  Effect.succeed({
    description:
      "Create a credential-free, non-executable fund action proposal bound to immutable evidence and strategy hashes. A separate policy gateway must authorize and perform any state change.",
    parameters: FundActionProposalParameters,
    execute: (input, ctx) =>
      Effect.sync(() => {
        const proposal = createFundActionProposal(ctx.agent, input)
        if (!proposal) {
          return {
            title: "Fund action proposal rejected",
            output: `Only "${FUND_MANAGER_AGENT}" may submit a fund action proposal.`,
            metadata: { accepted: false, code: "unauthorized_agent" } satisfies ActionProposalMetadata,
          }
        }
        return {
          title: "Fund action proposal accepted",
          output: `Proposal ${proposal.proposalSha256} accepted for policy-gateway review. No action was executed.`,
          metadata: { accepted: true, proposal } satisfies ActionProposalMetadata,
        }
      }),
  }),
)
