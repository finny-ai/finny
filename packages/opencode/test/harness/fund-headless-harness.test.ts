import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  FundHeadlessScenarioV1,
  FundHeadlessTraceV1,
  evaluateFundRuntimeScenario,
  evaluateFundScenario,
  fundScenarioSha256,
  loadFundScenario,
  loadFundTrace,
} from "../../script/headless/fund-scenario"
import { HeadlessScenarioV1 } from "../../script/headless/types"

const fixtureRoot = path.resolve(import.meta.dir, "../../harness/fund-scenarios")

async function fixture(name: string) {
  const scenario = await loadFundScenario(path.join(fixtureRoot, `${name}.scenario.v1.json`))
  const trace = await loadFundTrace(path.join(fixtureRoot, `${name}.trace.v1.json`))
  return { scenario, trace }
}

describe("deterministic fund headless harness", () => {
  test("static fixtures stay synthetic-only while the local runtime proves tool and TaskState boundaries", async () => {
    for (const name of ["regime-change-open-position", "fill-mismatch-logic-review"]) {
      const { scenario, trace } = await fixture(name)
      const synthetic = evaluateFundScenario(scenario, trace)
      expect(synthetic.status).toBe("synthetic_validated")
      expect(synthetic.proofKind).toBe("synthetic_fixture")
      expect(synthetic.runtimeSession).toBeUndefined()
      expect(synthetic.providerBacked).toBe(false)
      expect(synthetic.paperEligible).toBe(false)
      expect(synthetic.approvalEvidenceAccepted).toBe(false)
      expect(synthetic.executionEvidenceAccepted).toBe(false)

      const first = await evaluateFundRuntimeScenario(scenario, trace)
      const second = await evaluateFundRuntimeScenario(scenario, trace)
      expect(first).toEqual(second)
      expect(first.status).toBe("completed")
      expect(first.exitCode).toBe(0)
      expect(first.model).toBe("google/gemini-3.6-flash")
      expect(first.proofKind).toBe("deterministic_runtime")
      expect(first.evidenceMode).toBe("synthetic_offline")
      expect(first.providerBacked).toBe(false)
      expect(first.paperEligible).toBe(false)
      expect(first.executionAttemptCount).toBe(0)
      expect(first.specialists).toContain("fund_independent_validator")
      expect(first.specialists).toContain("fund_risk_sentinel")
      expect(first.violations).toEqual([])
      expect(Object.values(first.stages).every((stage) => stage === "completed")).toBe(true)
      expect(first.runtimeSession?.runtime).toBe("deterministic_local")
      expect(first.runtimeSession?.taskStateStore).toBe("ephemeral_sqlite")
      expect(first.runtimeSession?.tasks).toHaveLength(scenario.expected.specialists.length)
      expect(first.runtimeSession?.tasks.every((task) => task.states.join(",") === "queued,running,completed")).toBe(
        true,
      )
      expect(first.runtimeSession?.proposal?.executionAuthorized).toBe(false)
      expect(first.runtimeSession?.boundaryChecks).toEqual({
        managerSpecialistReportRejected: true,
        specialistActionProposalRejected: true,
        specialistNestedDelegationRejected: true,
        unregisteredDelegationRejected: true,
        dangerousManagerPermissionsDenied: true,
        dangerousSpecialistPermissionsDenied: true,
      })
      expect(first.runtimeSession?.permissionChecks.every((check) => check.expected === check.observed)).toBe(true)
    }
  })

  test("fixture provenance is mandatory, offline, and cannot claim provider-backed evidence", async () => {
    const { trace } = await fixture("regime-change-open-position")
    const { provenance: _provenance, ...withoutProvenance } = trace
    expect(FundHeadlessTraceV1.safeParse(withoutProvenance).success).toBe(false)
    expect(
      FundHeadlessTraceV1.safeParse({
        ...trace,
        provenance: { ...trace.provenance, providerBacked: true },
      }).success,
    ).toBe(false)
    expect(
      FundHeadlessTraceV1.safeParse({
        ...trace,
        runtimeSession: { accepted: true },
      }).success,
    ).toBe(false)
  })

  test("static fixtures cannot self-report a human approval as accepted", async () => {
    const { scenario, trace } = await fixture("fill-mismatch-logic-review")
    const events = trace.events.map((event) =>
      event.type === "approval_gated" ? { ...event, status: "approved" as const } : event,
    )
    const observed = evaluateFundScenario(scenario, FundHeadlessTraceV1.parse({ ...trace, events }))
    expect(observed.status).toBe("contract_failed")
    expect(observed.approvalEvidenceAccepted).toBe(false)
    expect(observed.violations.map((item) => item.code)).toContain("synthetic_approval_claim")
  })

  test("model drift fails closed", async () => {
    const { scenario, trace } = await fixture("regime-change-open-position")
    const observed = evaluateFundScenario(
      scenario,
      FundHeadlessTraceV1.parse({ ...trace, model: "google/gemini-3.5-flash" }),
    )
    expect(observed.status).toBe("contract_failed")
    expect(observed.exitCode).toBe(2)
    expect(observed.violations.map((item) => item.code)).toContain("model_mismatch")
  })

  test("execution attempts and self-authorized proposals fail closed", async () => {
    const { scenario, trace } = await fixture("regime-change-open-position")
    const events = trace.events.map((event) =>
      event.type === "decision_proposed" ? { ...event, executionAuthorized: true } : event,
    )
    events.push({ type: "execution_attempted", action: "propose_pause" })
    const observed = evaluateFundScenario(scenario, FundHeadlessTraceV1.parse({ ...trace, events }))
    const codes = observed.violations.map((item) => item.code)
    expect(codes).toContain("execution_authority_leak")
    expect(codes).toContain("execution_attempted")
    expect(observed.executionAttemptCount).toBe(1)
  })

  test("missing specialists and changed open positions fail closed", async () => {
    const { scenario, trace } = await fixture("fill-mismatch-logic-review")
    const events = trace.events
      .filter((event) => event.type !== "specialist_completed" || event.agent !== "fund_code_change_agent")
      .map((event) => (event.type === "position_preserved" ? { ...event, afterQuantity: 0.01 } : event))
    const observed = evaluateFundScenario(scenario, FundHeadlessTraceV1.parse({ ...trace, events }))
    const codes = observed.violations.map((item) => item.code)
    expect(codes).toContain("required_specialist_missing")
    expect(codes).toContain("position_not_preserved")
    expect(codes).toContain("required_stage_missing")
  })

  test("reordered stages and replayed report hashes fail closed", async () => {
    const { scenario, trace } = await fixture("fill-mismatch-logic-review")
    const decision = trace.events.find((event) => event.type === "decision_proposed")!
    const reordered = [
      ...trace.events.filter((event) => event.type === "event_bound" || event.type === "context_verified"),
      decision,
      ...trace.events.filter(
        (event) =>
          event.type !== "event_bound" && event.type !== "context_verified" && event.type !== "decision_proposed",
      ),
    ]
    const reorderedResult = evaluateFundScenario(scenario, FundHeadlessTraceV1.parse({ ...trace, events: reordered }))
    expect(reorderedResult.violations.map((item) => item.code)).toContain("stage_order_violation")

    const replayed = trace.events.map((event) =>
      event.type === "specialist_completed" ? { ...event, reportSha256: "a".repeat(64) } : event,
    )
    const replayedResult = evaluateFundScenario(scenario, FundHeadlessTraceV1.parse({ ...trace, events: replayed }))
    expect(replayedResult.violations.map((item) => item.code)).toContain("duplicate_specialist_report")
  })

  test("runtime-derived risk and approval policy cannot be overridden by the fixture", async () => {
    const { scenario, trace } = await fixture("regime-change-open-position")
    const changedScenario = FundHeadlessScenarioV1.parse({
      ...scenario,
      expected: {
        ...scenario.expected,
        riskTier: "material_change",
        humanApprovalRequired: true,
      },
    })
    const changedTrace = FundHeadlessTraceV1.parse({
      ...trace,
      events: trace.events.map((event) => {
        if (event.type === "decision_proposed") return { ...event, riskTier: "material_change" as const }
        if (event.type === "approval_gated") return { ...event, required: true, status: "pending" as const }
        return event
      }),
    })
    expect(evaluateFundScenario(changedScenario, changedTrace).status).toBe("synthetic_validated")
    const observed = await evaluateFundRuntimeScenario(changedScenario, changedTrace)
    expect(observed.status).toBe("contract_failed")
    expect(observed.violations.map((item) => item.code)).toContain("runtime_proposal_mismatch")
  })

  test("fund contract is separate and does not weaken the strategy harness schema", async () => {
    const { scenario } = await fixture("regime-change-open-position")
    expect(HeadlessScenarioV1.safeParse(scenario).success).toBe(false)

    const strategyScenario = JSON.parse(
      await fs.readFile(path.resolve(import.meta.dir, "../../harness/scenarios/spy-5m-sma-crossover.v1.json"), "utf8"),
    )
    expect(HeadlessScenarioV1.safeParse(strategyScenario).success).toBe(true)
    expect(FundHeadlessScenarioV1.safeParse(strategyScenario).success).toBe(false)
  })

  test("scenario hash binds every policy field", async () => {
    const { scenario } = await fixture("regime-change-open-position")
    const baseline = fundScenarioSha256(scenario)
    const changed = FundHeadlessScenarioV1.parse({
      ...scenario,
      limits: {
        ...scenario.limits,
        specialists: scenario.limits.specialists + 1,
      },
    })
    expect(fundScenarioSha256(changed)).not.toBe(baseline)
  })
})
