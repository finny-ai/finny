import { describe, expect, test } from "bun:test"
import { FUND_ACTION_POLICY } from "../../src/agent/fund-policy"
import {
  FundActionDraftParameters,
  FundActionProposalParameters,
  FundActionType,
  FundSpecialistReportParameters,
  containsCredentialMaterial,
} from "../../src/tool/fund-contracts"

const hash = (character: string) => character.repeat(64)
const portfolioSnapshot = {
  kind: "portfolio_snapshot" as const,
  ref: "portfolio-001",
  sha256: hash("a"),
}
const marketSnapshot = {
  kind: "market_snapshot" as const,
  ref: "market-001",
  sha256: hash("b"),
}
const strategy = {
  strategyId: "strategy-001",
  version: 4,
  codeSha256: hash("c"),
  configSha256: hash("d"),
}
const reportInput = {
  subject: "BTC regime transition",
  summary: "Volatility and trend evidence disagree, so request another bounded review.",
  recommendation: "investigate" as const,
  confidence: 0.72,
  evidence: [
    {
      kind: "regime_observation" as const,
      ref: "regime-001",
      sha256: hash("e"),
    },
  ],
  riskFlags: ["model_uncertainty" as const],
}
const pauseProposal = {
  action: "propose_pause" as const,
  strategy,
  portfolioSnapshot,
  marketSnapshot,
  rationale: "Pause is proposed for gateway review while preserving the open position.",
  confidence: 0.81,
  specialistReports: [
    { agent: "fund_risk_analyst" as const, reportSha256: hash("e") },
    { agent: "fund_risk_sentinel" as const, reportSha256: hash("f") },
  ],
  evidence: [portfolioSnapshot, marketSnapshot],
  contraryEvidence: [],
}

describe("typed fund tool contracts", () => {
  test("specialist input cannot self-report case, event, role, draft, or timestamp provenance", () => {
    expect(FundSpecialistReportParameters.safeParse(reportInput).success).toBe(true)
    for (const forged of [
      { caseId: "case-001" },
      { eventId: "event-001" },
      { observedAt: "2026-07-27T18:00:00Z" },
      { specialist: "risk_analyst" },
      { draftSha256: hash("1") },
      { reportSha256: hash("2") },
    ]) {
      expect(FundSpecialistReportParameters.safeParse({ ...reportInput, ...forged }).success).toBe(false)
    }
  })

  test("proposal input cannot self-report server authority fields", () => {
    expect(FundActionProposalParameters.safeParse(pauseProposal).success).toBe(true)
    for (const forged of [
      { proposedAt: "2026-07-27T18:01:00Z" },
      { idempotencyKey: "proposal-001" },
      { riskTier: "observation" },
      { humanApprovalRequired: false },
      { executionAuthorized: true },
      { gatewayReview: "approved" },
      { caseId: "case-001" },
      { eventId: "event-001" },
    ]) {
      expect(FundActionProposalParameters.safeParse({ ...pauseProposal, ...forged }).success).toBe(false)
    }
  })

  test("action risk and required specialist policy is exhaustive and server-owned", () => {
    expect(Object.keys(FUND_ACTION_POLICY).toSorted()).toEqual([...FundActionType.options].toSorted())
    expect(FUND_ACTION_POLICY.propose_pause).toEqual({
      riskTier: "bounded_paper",
      requiredSpecialists: ["fund_risk_analyst", "fund_risk_sentinel"],
    })
    expect(FUND_ACTION_POLICY.propose_logic_change.riskTier).toBe("material_change")
    expect(FUND_ACTION_POLICY.propose_logic_change.requiredSpecialists).toEqual([
      "fund_code_change_agent",
      "fund_independent_validator",
      "fund_risk_sentinel",
    ])
  })

  test("material changes require a server-issued draft and exact post-draft reviewers", () => {
    const material = {
      ...pauseProposal,
      action: "propose_logic_change" as const,
      specialistReports: [
        { agent: "fund_code_change_agent" as const, reportSha256: hash("1") },
        { agent: "fund_independent_validator" as const, reportSha256: hash("2") },
        { agent: "fund_risk_sentinel" as const, reportSha256: hash("3") },
      ],
    }
    expect(FundActionProposalParameters.safeParse(material).success).toBe(false)
    expect(
      FundActionProposalParameters.safeParse({
        ...material,
        draftSha256: hash("4"),
      }).success,
    ).toBe(true)
    expect(
      FundActionDraftParameters.safeParse({
        ...material,
        specialistReports: [{ agent: "fund_code_change_agent", reportSha256: hash("1") }],
      }).success,
    ).toBe(true)
  })

  test("bounded sentinel review does not require a material draft", () => {
    expect(FundActionProposalParameters.safeParse(pauseProposal).success).toBe(true)
    expect(
      FundActionProposalParameters.safeParse({ ...pauseProposal, draftSha256: hash("1") }).success,
    ).toBe(false)
  })

  test("contracts contain no broker execution or infrastructure action", () => {
    expect(FundActionType.options).not.toContain("place_order")
    expect(FundActionType.options).not.toContain("cancel_order")
    expect(FundActionType.options).not.toContain("close_position")
    expect(FundActionType.options).not.toContain("deploy_railway")
  })

  test("strict schemas reject credentials and unknown fields", () => {
    expect(
      FundActionProposalParameters.safeParse({
        ...pauseProposal,
        rationale: "telegram_token=dummy-value",
      }).success,
    ).toBe(false)
    expect(
      FundSpecialistReportParameters.safeParse({
        ...reportInput,
        databaseUrl: "postgres://user:pass@example.invalid/db",
      }).success,
    ).toBe(false)
    expect(containsCredentialMaterial("api_key=dummy-value")).toBe(true)
    expect(containsCredentialMaterial("postgres://user:pass@example.invalid/db")).toBe(true)
    expect(containsCredentialMaterial(`Telegram bot credential 1234567890:${"A".repeat(35)}`)).toBe(true)
    expect(containsCredentialMaterial("Telegram approval is required; no credential is included.")).toBe(false)
  })
})
