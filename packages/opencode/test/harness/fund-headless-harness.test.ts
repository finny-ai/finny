import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  FundHeadlessScenarioV1,
  FundHeadlessTraceV1,
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
  test("regime-change and fill-review scenarios complete without execution", async () => {
    for (const name of ["regime-change-open-position", "fill-mismatch-logic-review"]) {
      const { scenario, trace } = await fixture(name)
      const first = evaluateFundScenario(scenario, trace)
      const second = evaluateFundScenario(scenario, trace)
      expect(first).toEqual(second)
      expect(first.status).toBe("completed")
      expect(first.exitCode).toBe(0)
      expect(first.model).toBe("google/gemini-3.6-flash")
      expect(first.executionAttemptCount).toBe(0)
      expect(first.specialists).toContain("fund_independent_validator")
      expect(first.specialists).toContain("fund_risk_sentinel")
      expect(first.violations).toEqual([])
      expect(Object.values(first.stages).every((stage) => stage === "completed")).toBe(true)
    }
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
