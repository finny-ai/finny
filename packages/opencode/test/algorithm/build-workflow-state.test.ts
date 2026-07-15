import { describe, expect, test } from "bun:test"
import {
  approvalScopeHash,
  backtestIdentityHash,
  conceptIdFor,
  createBuildWorkflow,
  evidenceRequirementsFor,
  experimentTrialSummary,
  makeApprovalChallenge,
  makeExperimentAttempt,
  paperTradingApprovalScope,
  requestJsonProjection,
  transition,
} from "@/algorithm/build-workflow/state"
import { controllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import type {
  BuildWorkflowState,
  CreateBuildWorkflowInput,
  EvidenceRecord,
  TransitionDecision,
  WorkflowEvent,
} from "@/algorithm/build-workflow/types"

const userSource = { kind: "user_message" as const, messageId: "msg_user_request" }

function workflowInput(overrides: Partial<CreateBuildWorkflowInput> = {}): CreateBuildWorkflowInput {
  return {
    workflowId: "wf_state",
    sessionId: "ses_state",
    workspaceSlug: "spy-btc-1h-momentum",
    intent: "build",
    newsRequired: true,
    identity: {
      symbols: { value: ["SPY", "BTC/USD"], source: userSource },
      interval: { value: "1hour", source: userSource },
      assetClass: { value: "mixed", source: userSource },
      algorithmName: { value: "spy-btc-1h-momentum", source: userSource },
      strategyFamily: { value: "momentum", source: userSource },
      window: {
        value: { start: "2026-01-01", end: "2026-07-01" },
        source: userSource,
      },
    },
    now: 1_000,
    ...overrides,
  }
}

function applied(decision: TransitionDecision): BuildWorkflowState {
  expect(decision.allowed, decision.allowed ? undefined : decision.message).toBe(true)
  if (!decision.allowed) throw new Error(decision.message)
  return decision.state
}

function event<T extends WorkflowEvent>(input: T): T {
  return input
}

function evidence(requirementId: string, kind: EvidenceRecord["kind"], id = requirementId): EvidenceRecord {
  return {
    id,
    requirementId,
    kind,
    status: "verified",
    verifiedAt: 1_100,
    issues: [],
  }
}

function readyWorkflow(): BuildWorkflowState {
  let state = createBuildWorkflow(workflowInput())
  const records = [
    evidence("market_data:BTC", "market_data"),
    evidence("market_data:SPY", "market_data"),
    evidence("news:request", "news"),
  ]
  records.forEach((record, index) => {
    state = applied(
      transition(
        state,
        event({
          id: `evt_evidence_${index}`,
          type: "evidence.recorded",
          occurredAt: 1_100 + index,
          source: { actor: "subagent" },
          evidence: record,
        }),
      ),
    )
  })
  return state
}

function reviewableWorkflow(): BuildWorkflowState {
  let state = readyWorkflow()
  state = applied(
    transition(state, {
      id: "evt_freeze",
      type: "research.frozen",
      occurredAt: 1_150,
      source: { actor: "tool" },
      freeze: {
        id: "freeze_1",
        requestVersion: 1,
        evidenceIds: state.evidence.map((item) => item.id),
        createdAt: 1_150,
      },
    }),
  )
  state = applied(
    transition(
      state,
      event({
        id: "evt_candidate",
        type: "candidate.saved",
        occurredAt: 1_200,
        source: { actor: "tool" },
        candidate: {
          algorithmId: "algo_1",
          name: "spy-btc-1h-momentum",
          version: 1,
          strategyHash: "strategy_hash",
          configHash: "config_hash",
          conceptId: "concept_1",
        },
      }),
    ),
  )
  state = applied(
    transition(state, {
      id: "evt_plan",
      type: "experiment.plan_bound",
      occurredAt: 1_250,
      source: { actor: "tool" },
      plan: {
        id: "plan_1",
        requestVersion: 1,
        candidateId: "algo_1",
        fingerprint: "plan_fingerprint",
        createdAt: 1_250,
      },
    }),
  )
  state = applied(
    transition(state, {
      id: "evt_started",
      type: "backtest.started",
      occurredAt: 1_300,
      source: { actor: "tool" },
    }),
  )
  const hashes = {
    strategyHash: "strategy_hash",
    savedConfigHash: "config_hash",
    effectiveConfigHash: "effective_config_hash",
    dataHash: "data_hash",
    manifestHash: "manifest_hash",
    engineHash: "engine_hash",
    windowHash: "window_hash",
    strictRunIdentityHash: "a".repeat(64),
  }
  return applied(
    transition(state, {
      id: "evt_completed",
      type: "backtest.completed",
      occurredAt: 1_400,
      source: { actor: "tool" },
      backtest: {
        runId: "run_1",
        strategyHash: "strategy_hash",
        configHash: "config_hash",
        dataHash: "data_hash",
        engineHash: "engine_hash",
        hashes,
        identityHash: backtestIdentityHash(hashes),
        verdict: "recommended_for_paper",
      },
    }),
  )
}

describe("algorithm build workflow evidence policy", () => {
  test("derives deterministic request-scoped requirements", () => {
    const requirements = evidenceRequirementsFor({
      ...workflowInput(),
      filingDependent: true,
      sentimentRequired: true,
    })
    expect(requirements.map((item) => item.id)).toEqual([
      "market_data:BTC",
      "market_data:SPY",
      "news:request",
      "sec:request",
      "sentiment:request",
    ])

    const plainBuild = evidenceRequirementsFor({
      intent: "build",
      identity: workflowInput().identity,
    })
    expect(plainBuild.map((item) => item.id)).toEqual(["market_data:BTC", "market_data:SPY"])

    const research = evidenceRequirementsFor({
      intent: "research",
      identity: workflowInput().identity,
    })
    expect(research.map((item) => item.id)).toEqual([])
  })

  test("does not admit a candidate until every required evidence item is verified", () => {
    const initial = createBuildWorkflow(workflowInput())
    const blocked = transition(initial, {
      id: "evt_candidate_early",
      type: "candidate.saved",
      occurredAt: 1_001,
      source: { actor: "tool" },
      candidate: {
        algorithmId: "algo_1",
        name: "spy-btc-1h-momentum",
        version: 1,
        strategyHash: "strategy_hash",
        configHash: "config_hash",
        conceptId: "concept_1",
      },
    })
    expect(blocked).toMatchObject({ allowed: false, code: "evidence_not_ready" })

    const ready = readyWorkflow()
    expect(ready.stage).toBe("evidence_ready")
    expect(ready.revision).toBe(3)
  })

  test("projects request.json from authoritative typed state", () => {
    const projection = requestJsonProjection(readyWorkflow())
    expect(projection).toMatchObject({
      source_of_truth: "algorithm_build_workflow",
      workflow_id: "wf_state",
      workflow_revision: 3,
      request_id: "ses_state",
      requested_symbols: ["SPY", "BTC/USD"],
      requested_interval: "1h",
      requested_start: "2026-01-01",
      requested_end: "2026-07-01",
    })
    expect(projection.provenance.requested_window).toEqual(userSource)
  })
})

describe("algorithm build workflow approvals", () => {
  test("requires a pending exact-scope challenge and a non-synthetic user message", () => {
    let state = reviewableWorkflow()
    const scope = {
      runId: "run_1",
      strategyHash: "strategy_hash",
      configHash: "config_hash",
      dataHash: "data_hash",
      engineHash: "engine_hash",
      hashes: state.backtest!.hashes,
      identityHash: state.backtest!.identityHash,
    }
    const challenge = makeApprovalChallenge({
      id: "approval_1",
      kind: "paper_trading",
      scope,
      reason: "Approve the exact reviewed run for paper trading.",
      now: 1_500,
    })
    state = applied(
      transition(state, {
        id: "evt_approval_requested",
        type: "approval.requested",
        occurredAt: 1_500,
        source: { actor: "tool" },
        challenge,
      }),
    )

    const synthetic = transition(state, {
      id: "evt_synthetic_approval",
      type: "approval.granted",
      occurredAt: 1_600,
      source: { actor: "user", messageId: "msg_synthetic", synthetic: true },
      challengeId: challenge.id,
      scopeHash: challenge.scopeHash,
    })
    expect(synthetic).toMatchObject({ allowed: false, code: "approval_source_not_user" })

    const wrongScope = transition(state, {
      id: "evt_wrong_scope",
      type: "approval.granted",
      occurredAt: 1_600,
      source: { actor: "user", messageId: "msg_user_approval" },
      challengeId: challenge.id,
      scopeHash: approvalScopeHash("paper_trading", { ...scope, runId: "run_other" }),
    })
    expect(wrongScope).toMatchObject({ allowed: false, code: "approval_scope_mismatch" })

    const approved = applied(
      transition(state, {
        id: "evt_user_approval",
        type: "approval.granted",
        occurredAt: 1_600,
        source: { actor: "user", messageId: "msg_user_approval" },
        challengeId: challenge.id,
        scopeHash: challenge.scopeHash,
      }),
    )
    expect(approved.stage).toBe("paper_approved")
    expect(approved.approvals).toEqual([
      {
        challengeId: "approval_1",
        kind: "paper_trading",
        scopeHash: challenge.scopeHash,
        sourceMessageId: "msg_user_approval",
        grantedAt: 1_600,
      },
    ])
  })

  test("rejects subagent approval and accepts only a structured user response", () => {
    let state = createBuildWorkflow(workflowInput())
    const challenge = makeApprovalChallenge({
      id: "approval_budget",
      kind: "failure_budget_override",
      scope: { conceptId: "concept_1" },
      reason: "Continue this exact concept after five metric trials.",
      now: 2_000,
    })
    state = applied(
      transition(state, {
        id: "evt_budget_requested",
        type: "approval.requested",
        occurredAt: 2_000,
        source: { actor: "tool" },
        challenge,
      }),
    )
    expect(
      transition(state, {
        id: "evt_subagent_grant",
        type: "approval.granted",
        occurredAt: 2_100,
        source: { actor: "subagent", messageId: "msg_child" },
        challengeId: challenge.id,
        scopeHash: challenge.scopeHash,
      }),
    ).toMatchObject({ allowed: false, code: "approval_source_not_user" })

    const approved = applied(
      transition(state, {
        id: "evt_structured_grant",
        type: "approval.granted",
        occurredAt: 2_100,
        source: {
          actor: "user",
          structuredResponse: true,
          questionRequestId: "que_structured",
        },
        challengeId: challenge.id,
        scopeHash: challenge.scopeHash,
      }),
    )
    expect(approved.approvals[0]).toMatchObject({
      challengeId: challenge.id,
      questionRequestId: "que_structured",
    })
  })

  test("derives a promotion proof only from the exact approved strict run", () => {
    let state = reviewableWorkflow()
    const challenge = makeApprovalChallenge({
      id: "approval_strict_run",
      kind: "paper_trading",
      scope: paperTradingApprovalScope(state.backtest!),
      reason: "Approve the exact strict run.",
      now: 2_500,
    })
    state = applied(
      transition(state, {
        id: "evt_strict_approval_requested",
        type: "approval.requested",
        occurredAt: 2_500,
        source: { actor: "tool" },
        challenge,
      }),
    )
    state = applied(
      transition(state, {
        id: "evt_strict_approval_granted",
        type: "approval.granted",
        occurredAt: 2_600,
        source: { actor: "user", structuredResponse: true, questionRequestId: "question_strict" },
        challengeId: challenge.id,
        scopeHash: challenge.scopeHash,
      }),
    )
    expect(
      controllerPaperApproval(state, {
        algorithmId: "algo_1",
        algorithmVersion: 1,
        runId: "run_1",
        identityHash: "a".repeat(64),
      }),
    ).toMatchObject({
      workflowId: state.workflowId,
      challengeId: challenge.id,
      questionRequestId: "question_strict",
    })
    expect(
      controllerPaperApproval(state, {
        algorithmId: "algo_1",
        algorithmVersion: 1,
        runId: "run_1",
        identityHash: "b".repeat(64),
      }),
    ).toBeUndefined()
  })
})

describe("algorithm build workflow experiment ledger", () => {
  const definition = {
    symbol: "SPY",
    assetClass: "equity",
    interval: "1hour",
    strategyFamily: "Momentum",
    direction: "long",
    entryRules: "Close crosses above the 20 bar SMA",
    exitRules: "Close crosses below the 20 bar SMA",
  }

  test("concept identity ignores names and normalizes rule text", () => {
    expect(conceptIdFor(definition)).toBe(
      conceptIdFor({
        ...definition,
        interval: "1h",
        entryRules: "  close   crosses ABOVE the 20 bar SMA ",
      }),
    )
  })

  test("counts renamed metric variants, deduplicates replay, and ignores infrastructure failures", () => {
    let state = createBuildWorkflow(workflowInput())
    const conceptId = conceptIdFor(definition)
    const record = (
      id: string,
      strategyHash: string,
      savedConfigHash: string,
      outcome: "metrics" | "setup_failure" | "engine_failure",
    ) => {
      const attempt = makeExperimentAttempt({
        id,
        experimentId: state.workflowId,
        conceptId,
        strategyHash,
        savedConfigHash,
        datasetHash: "dataset_hash",
        windowHash: "window_hash",
        gridTrials: 1,
        outcome,
        createdAt: 3_000 + state.revision,
      })
      state = applied(
        transition(state, {
          id: `event_${id}`,
          type: "experiment.recorded",
          occurredAt: attempt.createdAt,
          source: { actor: "tool" },
          attempt,
        }),
      )
      return attempt
    }

    record("attempt_setup", "strategy_setup", "config_setup", "setup_failure")
    record("attempt_engine", "strategy_engine", "config_engine", "engine_failure")
    const variants = [1, 2, 3, 4].map((index) =>
      record(`attempt_variant_${index}`, `strategy_${index}`, `config_${index}`, "metrics"),
    )
    expect(experimentTrialSummary(state, { conceptId }).priorUniqueTrials).toBe(4)

    const replay = record("attempt_replay", variants[0]!.strategyHash, variants[0]!.savedConfigHash, "metrics")
    expect(experimentTrialSummary(state, { conceptId, replayKey: replay.replayKey })).toMatchObject({
      priorUniqueTrials: 4,
      currentGridTrials: 0,
      totalDsrTrials: 4,
      replayOfAttemptId: "attempt_variant_1",
    })

    record("attempt_variant_5", "strategy_5", "config_5", "metrics")
    const sixth = makeExperimentAttempt({
      id: "attempt_variant_6",
      experimentId: state.workflowId,
      conceptId,
      strategyHash: "strategy_6",
      savedConfigHash: "config_6",
      datasetHash: "dataset_hash",
      windowHash: "window_hash",
      gridTrials: 1,
      outcome: "metrics",
      createdAt: 4_000,
    })
    const decision = transition(state, {
      id: "event_attempt_variant_6",
      type: "experiment.recorded",
      occurredAt: 4_000,
      source: { actor: "tool" },
      attempt: sixth,
    })
    expect(decision.allowed).toBe(true)
  })
})

describe("WorkflowRunV2 identity, attempts, terminal state, and resume", () => {
  test("requires durable research freeze and experiment plan transitions in order", () => {
    let state = readyWorkflow()
    const candidate = {
      algorithmId: "algo_phase",
      name: "phase-order",
      version: 1,
      strategyHash: "strategy_phase",
      configHash: "config_phase",
      conceptId: "concept_phase",
    }
    expect(
      transition(state, {
        id: "evt_candidate_without_freeze",
        type: "candidate.saved",
        occurredAt: 2_000,
        source: { actor: "tool" },
        candidate,
      }),
    ).toMatchObject({ allowed: false, code: "evidence_not_ready" })
    state = applied(
      transition(state, {
        id: "evt_research_freeze_order",
        type: "research.frozen",
        occurredAt: 2_010,
        source: { actor: "tool" },
        freeze: { id: "freeze_order", requestVersion: 1, evidenceIds: state.evidence.map((item) => item.id), createdAt: 2_010 },
      }),
    )
    expect(state.phase).toBe("research_frozen")
    expect(
      transition(state, {
        id: "evt_plan_without_candidate",
        type: "experiment.plan_bound",
        occurredAt: 2_020,
        source: { actor: "tool" },
        plan: { id: "plan_early", requestVersion: 1, candidateId: "algo_phase", fingerprint: "early", createdAt: 2_020 },
      }),
    ).toMatchObject({ allowed: false, code: "experiment_plan_candidate_required" })
    state = applied(
      transition(state, {
        id: "evt_candidate_after_freeze",
        type: "candidate.saved",
        occurredAt: 2_030,
        source: { actor: "tool" },
        candidate,
      }),
    )
    expect(
      transition(state, { id: "evt_strict_without_plan", type: "backtest.started", occurredAt: 2_040, source: { actor: "tool" } }),
    ).toMatchObject({ allowed: false, code: "experiment_plan_required" })
    state = applied(
      transition(state, {
        id: "evt_plan_after_candidate",
        type: "experiment.plan_bound",
        occurredAt: 2_050,
        source: { actor: "tool" },
        plan: { id: "plan_order", requestVersion: 1, candidateId: "algo_phase", fingerprint: "bound", createdAt: 2_050 },
      }),
    )
    expect(state.phase).toBe("experiment_planned")
    state = applied(
      transition(state, { id: "evt_strict_after_plan", type: "backtest.started", occurredAt: 2_060, source: { actor: "tool" } }),
    )
    expect(state.phase).toBe("strict_running")
  })

  test("keeps delegated identity proposed until a structured symbol is confirmed", () => {
    let state = createBuildWorkflow(workflowInput({ identity: {}, identityStatus: "proposed" }))
    expect(state).toMatchObject({ runVersion: 2, phase: "identity_proposed", identityStatus: "proposed" })
    const source = { kind: "structured_tool" as const, tool: "finny_workspace_prepare", callId: "call_1" }
    state = applied(
      transition(state, {
        id: "evt_confirm_spy",
        type: "identity.confirmed",
        occurredAt: 1_100,
        source: { actor: "tool" },
        identity: { symbols: { value: ["SPY"], source } },
      }),
    )
    expect(state).toMatchObject({ phase: "identity_confirmed", identityStatus: "confirmed", requestVersion: 1 })
  })

  test("structured identity confirmation reactivates a blocked proposed workflow", () => {
    let state = createBuildWorkflow(workflowInput({ identityStatus: "proposed" }))
    state = applied(
      transition(state, {
        id: "evt_block_unconfirmed_identity",
        type: "workflow.blocked",
        occurredAt: 1_050,
        source: { actor: "system" },
        blocker: {
          code: "identity_unconfirmed",
          message: "Structured request identity confirmation is required before lifecycle advancement.",
          fingerprint: "proposed:SPY:BTC/USD",
          requiredChanges: ["Confirm identity with finny_workspace_prepare."],
        },
      }),
    )
    expect(state).toMatchObject({
      status: "blocked",
      identityStatus: "proposed",
      blocker: { code: "identity_unconfirmed" },
      terminal: { classification: "blocked" },
    })

    const source = { kind: "structured_tool" as const, tool: "finny_workspace_prepare", callId: "call_recover" }
    state = applied(
      transition(state, {
        id: "evt_confirm_blocked_identity",
        type: "identity.confirmed",
        occurredAt: 1_100,
        source: { actor: "tool" },
        identity: { ...state.identity, symbols: { value: ["SPY", "BTC/USD"], source } },
      }),
    )
    expect(state).toMatchObject({
      status: "active",
      phase: "identity_confirmed",
      stage: "evidence_pending",
      identityStatus: "confirmed",
      blocker: undefined,
      terminal: undefined,
    })
  })

  test("amends identity once and invalidates dependent evidence and candidates deterministically", () => {
    let state = readyWorkflow()
    state = applied(
      transition(state, {
        id: "evt_freeze_before_amendment",
        type: "research.frozen",
        occurredAt: 1_200,
        source: { actor: "tool" },
        freeze: {
          id: "freeze_before_amendment",
          requestVersion: 1,
          evidenceIds: state.evidence.map((item) => item.id),
          createdAt: 1_200,
        },
      }),
    )
    state = applied(
      transition(state, {
        id: "evt_candidate_before_amendment",
        type: "candidate.saved",
        occurredAt: 1_250,
        source: { actor: "tool" },
        candidate: {
          algorithmId: "algo_old",
          name: "old",
          version: 1,
          strategyHash: "old_strategy",
          configHash: "old_config",
          conceptId: "old_concept",
        },
      }),
    )
    const source = { kind: "structured_tool" as const, tool: "finny_workspace_prepare", callId: "call_amend" }
    state = applied(
      transition(state, {
        id: "evt_amend_qqq",
        type: "identity.amended",
        occurredAt: 1_300,
        source: { actor: "tool" },
        reason: "user confirmed QQQ before strict validation",
        identity: { ...state.identity, symbols: { value: ["QQQ"], source } },
      }),
    )
    expect(state).toMatchObject({ requestVersion: 2, phase: "identity_confirmed", evidence: [], candidate: undefined })
    expect(state.invalidations).toEqual([
      expect.objectContaining({
        requestVersion: 2,
        evidenceIds: expect.arrayContaining(["market_data:SPY", "market_data:BTC", "news:request"]),
        candidateIds: ["algo_old"],
        eventId: "evt_amend_qqq",
      }),
    ])
    expect(state.resumeToken).not.toBe(createBuildWorkflow(workflowInput()).resumeToken)
  })

  test("records rejected attempts and denies an unchanged blocker fingerprint", () => {
    let state = createBuildWorkflow(workflowInput())
    state = applied(
      transition(state, {
        id: "evt_attempt_blocked",
        type: "attempt.recorded",
        occurredAt: 1_100,
        source: { actor: "tool" },
        attempt: {
          id: "attempt_1",
          idempotencyKey: "save:finish:one:blocked",
          fingerprint: "same_inputs",
          operation: "finny_algorithm_save",
        outcome: "blocked",
        lifecycle: "terminal",
          blockerCode: "save_preflight_rejected",
          requiredChanges: ["config"],
          requestVersion: 1,
          artifactIds: [],
          evidenceIds: [],
          trialIds: [],
          createdAt: 1_100,
        },
      }),
    )
    expect(
      transition(state, {
        id: "evt_attempt_retry",
        type: "attempt.recorded",
        occurredAt: 1_200,
        source: { actor: "tool" },
        attempt: {
          ...state.attempts[0]!,
          id: "attempt_2",
          idempotencyKey: "save:begin:retry",
          createdAt: 1_200,
        },
      }),
    ).toMatchObject({ allowed: false, code: "unchanged_blocker_retry_denied" })
  })

  test("cannot report semantic completion before qualification", () => {
    const state = createBuildWorkflow(workflowInput())
    expect(
      transition(state, {
        id: "evt_complete_early",
        type: "workflow.completed",
        occurredAt: 1_100,
        source: { actor: "system" },
      }),
    ).toMatchObject({ allowed: false, code: "workflow_not_qualified" })
  })
})
