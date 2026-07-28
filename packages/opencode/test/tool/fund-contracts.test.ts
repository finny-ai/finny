import { describe, expect, test } from "bun:test"
import {
  FundActionProposalParameters,
  FundActionType,
  FundSpecialistReportParameters,
  containsCredentialMaterial,
  createFundActionProposal,
  createFundSpecialistReport,
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
  caseId: "case-001",
  eventId: "event-001",
  eventType: "regime_changed" as const,
  observedAt: "2026-07-27T18:00:00Z",
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

const proposalInput = {
  caseId: "case-001",
  eventId: "event-001",
  eventType: "regime_changed" as const,
  proposedAt: "2026-07-27T18:01:00Z",
  idempotencyKey: "proposal-001",
  action: "propose_pause" as const,
  strategy,
  portfolioSnapshot,
  marketSnapshot,
  rationale: "Pause is proposed for gateway review while preserving the open position.",
  confidence: 0.81,
  riskTier: "material_change" as const,
  specialistReports: [
    { agent: "fund_regime_analyst" as const, reportSha256: hash("e") },
    { agent: "fund_independent_validator" as const, reportSha256: hash("f") },
    { agent: "fund_risk_sentinel" as const, reportSha256: hash("1") },
  ],
  evidence: [portfolioSnapshot, marketSnapshot],
  contraryEvidence: [],
}

describe("typed fund tool contracts", () => {
  test("specialist reports are role-bound and deterministically hashed", () => {
    const first = createFundSpecialistReport("fund_regime_analyst", reportInput)
    const second = createFundSpecialistReport("fund_regime_analyst", reportInput)
    expect(first).toEqual(second)
    expect(first?.specialist).toBe("regime_analyst")
    expect(first?.reportSha256).toHaveLength(64)
    expect(createFundSpecialistReport("fund_manager", reportInput)).toBeUndefined()
    expect(createFundSpecialistReport("finny", reportInput)).toBeUndefined()
  })

  test("Fund Manager can only create a non-executable proposal", () => {
    const first = createFundActionProposal("fund_manager", proposalInput)
    const second = createFundActionProposal("fund_manager", proposalInput)
    expect(first).toEqual(second)
    expect(first?.proposalSha256).toHaveLength(64)
    expect(first?.executionAuthorized).toBe(false)
    expect(first?.gatewayReview).toBe("required")
    expect(first?.humanApprovalRequired).toBe(true)
    expect(first?.openPositionPolicy).toBe("preserve_existing")
    expect(createFundActionProposal("fund_risk_analyst", proposalInput)).toBeUndefined()
  })

  test("contracts contain no broker execution or infrastructure action", () => {
    expect(FundActionType.options).not.toContain("place_order")
    expect(FundActionType.options).not.toContain("cancel_order")
    expect(FundActionType.options).not.toContain("close_position")
    expect(FundActionType.options).not.toContain("deploy_railway")
    expect(
      FundActionType.options.every(
        (action) => action === "no_change" || action.startsWith("request_") || action.startsWith("propose_"),
      ),
    ).toBe(true)
  })

  test("strict schemas reject credential fields and credential material", () => {
    expect(
      FundActionProposalParameters.safeParse({
        ...proposalInput,
        telegramToken: "dummy-value",
      }).success,
    ).toBe(false)
    expect(
      FundActionProposalParameters.safeParse({
        ...proposalInput,
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

  test("mutating proposals require immutable strategy identity and exact snapshot kinds", () => {
    const { strategy: _strategy, ...withoutStrategy } = proposalInput
    expect(FundActionProposalParameters.safeParse(withoutStrategy).success).toBe(false)
    expect(
      FundActionProposalParameters.safeParse({
        ...proposalInput,
        portfolioSnapshot: marketSnapshot,
      }).success,
    ).toBe(false)
    expect(
      FundActionProposalParameters.safeParse({
        ...proposalInput,
        marketSnapshot: portfolioSnapshot,
      }).success,
    ).toBe(false)
  })

  test("material proposals require independent validation and a risk-sentinel challenge", () => {
    expect(
      FundActionProposalParameters.safeParse({
        ...proposalInput,
        specialistReports: proposalInput.specialistReports.filter(
          (report) => report.agent !== "fund_independent_validator",
        ),
      }).success,
    ).toBe(false)
    expect(
      FundActionProposalParameters.safeParse({
        ...proposalInput,
        specialistReports: proposalInput.specialistReports.filter((report) => report.agent !== "fund_risk_sentinel"),
      }).success,
    ).toBe(false)
  })

  test("strategy-build proposals can start without an existing strategy version", () => {
    const { strategy: _strategy, ...withoutStrategy } = proposalInput
    expect(
      FundActionProposalParameters.safeParse({
        ...withoutStrategy,
        action: "propose_strategy_build",
      }).success,
    ).toBe(true)
  })
})
