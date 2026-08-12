import { HeadlessScenarioV1 } from "./types"
import { FundHeadlessScenarioV1, FundHeadlessTraceV1 } from "./fund-scenario"

/**
 * Canonical harness scenarios and fund traces, inlined as typed constants so
 * the harness needs no JSON fixture files on disk. The zod schemas parse every
 * constant at module load, so a malformed fixture fails fast in tests.
 */

export const CROSSOVER_SCENARIO: HeadlessScenarioV1 = HeadlessScenarioV1.parse({
  schemaVersion: "1.0.0",
  id: "spy-5m-sma-crossover.v1",
  prompt:
    "Build exactly one SPY 5-minute SMA crossover strategy using data from 2026-01-09 through 2026-07-08. Save one version and run one strict unified backtest. Do not pivot to another strategy family. Report return, Sharpe, max drawdown, eligibility, blockers, and one next step.",
  asOfDate: "2026-07-09",
  limits: {
    wallTimeMs: 1200000,
    modelTurns: 40,
    toolCalls: 50,
    subagents: 4,
  },
  request: {
    symbols: ["SPY"],
    assetClass: "equity",
    interval: "5m",
    strategyFamilies: ["sma-crossover"],
    startDate: "2026-01-09",
    endDate: "2026-07-08",
  },
  artifactPolicy: {
    maxAlgorithms: 1,
    maxVersionsPerAlgorithm: 1,
    maxBacktests: 1,
  },
  requiredStages: [
    "request_bound",
    "evidence_ready",
    "candidate_saved",
    "validated",
    "backtested",
    "reviewable",
  ],
  requiredFinalFields: ["return", "sharpe", "max drawdown", "eligibility", "next step"],
  allowedRecoveries: [],
  observabilityRequired: true,
})

export const POSITIVE_QUALIFICATION_SCENARIO: HeadlessScenarioV1 = HeadlessScenarioV1.parse({
  schemaVersion: "1.0.0",
  id: "spy-5m-sma-positive-qualification.v1",
  prompt:
    "Build exactly one SPY 5-minute SMA crossover strategy using the closed synthetic fixture window 2026-01-09 through 2026-07-08. Bind the exact request, collect the configured deterministic evidence, save and validate one candidate, and run one strict unified research backtest. Then compile the immutable qualification plan, use only the exact runtime-issued structured sealed-holdout approval, execute every runtime-owned phase, and create one final review packet only if the authoritative run reaches recommended_for_paper. Never call finny_paper_approve and never imply paper or live permission. Report return, Sharpe, max drawdown, eligibility, blockers, and one next step.",
  asOfDate: "2026-07-09",
  limits: {
    wallTimeMs: 1200000,
    modelTurns: 50,
    toolCalls: 60,
    subagents: 4,
  },
  request: {
    symbols: ["SPY"],
    assetClass: "equity",
    interval: "5m",
    strategyFamilies: ["sma-crossover"],
    startDate: "2026-01-09",
    endDate: "2026-07-08",
  },
  artifactPolicy: {
    maxAlgorithms: 1,
    maxVersionsPerAlgorithm: 1,
    maxBacktests: 1,
  },
  requiredStages: [
    "request_bound",
    "evidence_ready",
    "candidate_saved",
    "validated",
    "backtested",
    "experiment_planned",
    "holdout_approved",
    "qualified",
    "review_packet_ready",
  ],
  requiredFinalFields: ["return", "sharpe", "max drawdown", "eligibility", "blockers", "next step"],
  allowedRecoveries: [],
  observabilityRequired: true,
  approvals: {
    sealedHoldout: true,
  },
})

export const FILL_MISMATCH_SCENARIO: FundHeadlessScenarioV1 = FundHeadlessScenarioV1.parse({
  schemaVersion: "1.0.0",
  kind: "fund",
  id: "fill-mismatch-logic-review",
  model: "google/gemini-3.6-flash",
  event: {
    eventId: "evt-fill-001",
    eventType: "order_filled",
    assetClass: "equity",
    strategyId: "spy-reversion-001",
    strategyVersion: 7,
    openPosition: {
      positionId: "pos-spy-001",
      quantity: 4,
    },
  },
  expected: {
    action: "propose_logic_change",
    riskTier: "material_change",
    specialists: [
      "fund_fill_auditor",
      "fund_strategy_researcher",
      "fund_code_change_agent",
      "fund_independent_validator",
      "fund_risk_sentinel",
    ],
    humanApprovalRequired: true,
    preserveOpenPosition: true,
  },
  limits: {
    specialists: 5,
    decisions: 1,
  },
  requiredStages: [
    "event_bound",
    "context_verified",
    "specialists_completed",
    "decision_proposed",
    "approval_gated",
    "position_preserved",
  ],
  forbidExecution: true,
})

export const FILL_MISMATCH_TRACE: FundHeadlessTraceV1 = FundHeadlessTraceV1.parse({
  schemaVersion: "1.0.0",
  scenarioId: "fill-mismatch-logic-review",
  model: "google/gemini-3.6-flash",
  provenance: {
    evidenceMode: "synthetic_offline",
    fixture: "static_json",
    providerBacked: false,
    networkAccess: "disabled",
  },
  events: [
    {
      type: "event_bound",
      eventId: "evt-fill-001",
      eventType: "order_filled",
      strategyId: "spy-reversion-001",
      strategyVersion: 7,
    },
    {
      type: "context_verified",
      portfolioSnapshotSha256: "1111111111111111111111111111111111111111111111111111111111111111",
      marketSnapshotSha256: "2222222222222222222222222222222222222222222222222222222222222222",
    },
    {
      type: "specialist_completed",
      agent: "fund_fill_auditor",
      reportSha256: "3333333333333333333333333333333333333333333333333333333333333333",
    },
    {
      type: "specialist_completed",
      agent: "fund_strategy_researcher",
      reportSha256: "4444444444444444444444444444444444444444444444444444444444444444",
    },
    {
      type: "specialist_completed",
      agent: "fund_code_change_agent",
      reportSha256: "5555555555555555555555555555555555555555555555555555555555555555",
    },
    {
      type: "specialist_completed",
      agent: "fund_independent_validator",
      reportSha256: "6666666666666666666666666666666666666666666666666666666666666666",
    },
    {
      type: "specialist_completed",
      agent: "fund_risk_sentinel",
      reportSha256: "8888888888888888888888888888888888888888888888888888888888888888",
    },
    {
      type: "decision_proposed",
      action: "propose_logic_change",
      riskTier: "material_change",
      proposalSha256: "7777777777777777777777777777777777777777777777777777777777777777",
      executionAuthorized: false,
      openPositionPolicy: "preserve_existing",
    },
    {
      type: "approval_gated",
      required: true,
      status: "pending",
    },
    {
      type: "position_preserved",
      positionId: "pos-spy-001",
      beforeQuantity: 4,
      afterQuantity: 4,
    },
  ],
})

export const REGIME_CHANGE_SCENARIO: FundHeadlessScenarioV1 = FundHeadlessScenarioV1.parse({
  schemaVersion: "1.0.0",
  kind: "fund",
  id: "regime-change-open-position",
  model: "google/gemini-3.6-flash",
  event: {
    eventId: "evt-regime-001",
    eventType: "regime_changed",
    assetClass: "crypto",
    strategyId: "btc-trend-001",
    strategyVersion: 3,
    openPosition: {
      positionId: "pos-btc-001",
      quantity: 0.05,
    },
  },
  expected: {
    action: "propose_pause",
    riskTier: "bounded_paper",
    specialists: ["fund_regime_analyst", "fund_risk_analyst", "fund_independent_validator", "fund_risk_sentinel"],
    humanApprovalRequired: false,
    preserveOpenPosition: true,
  },
  limits: {
    specialists: 4,
    decisions: 1,
  },
  requiredStages: [
    "event_bound",
    "context_verified",
    "specialists_completed",
    "decision_proposed",
    "approval_gated",
    "position_preserved",
  ],
  forbidExecution: true,
})

export const REGIME_CHANGE_TRACE: FundHeadlessTraceV1 = FundHeadlessTraceV1.parse({
  schemaVersion: "1.0.0",
  scenarioId: "regime-change-open-position",
  model: "google/gemini-3.6-flash",
  provenance: {
    evidenceMode: "synthetic_offline",
    fixture: "static_json",
    providerBacked: false,
    networkAccess: "disabled",
  },
  events: [
    {
      type: "event_bound",
      eventId: "evt-regime-001",
      eventType: "regime_changed",
      strategyId: "btc-trend-001",
      strategyVersion: 3,
    },
    {
      type: "context_verified",
      portfolioSnapshotSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      marketSnapshotSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    {
      type: "specialist_completed",
      agent: "fund_regime_analyst",
      reportSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
    {
      type: "specialist_completed",
      agent: "fund_risk_analyst",
      reportSha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
    {
      type: "specialist_completed",
      agent: "fund_independent_validator",
      reportSha256: "abababababababababababababababababababababababababababababababab",
    },
    {
      type: "specialist_completed",
      agent: "fund_risk_sentinel",
      reportSha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    },
    {
      type: "decision_proposed",
      action: "propose_pause",
      riskTier: "bounded_paper",
      proposalSha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      executionAuthorized: false,
      openPositionPolicy: "preserve_existing",
    },
    {
      type: "approval_gated",
      required: false,
      status: "not_required",
    },
    {
      type: "position_preserved",
      positionId: "pos-btc-001",
      beforeQuantity: 0.05,
      afterQuantity: 0.05,
    },
  ],
})
