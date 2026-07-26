import { describe, expect, test } from "bun:test"
import { compileExperimentPlanV1, planHash, type AuthoritativeBarV1 } from "../../src/backtest/experiment-plan"
import {
  executeQualificationPlanV1,
  executeQualificationWithHoldoutApprovalV1,
} from "../../src/backtest/qualification-operation"
import {
  DEFAULT_QUALIFICATION_POLICY_V1,
  makeHoldoutOpenEventV1,
  makeQualificationPolicyV1,
  qualificationHash,
} from "../../src/backtest/qualification-policy"
import {
  DurableQualificationAttemptLedgerV1,
  readQualificationAttemptEventsV1,
} from "../../src/backtest/qualification-attempt-ledger"
import { afterEach, beforeEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { experimentRootDir } from "../../src/backtest/experiment"

const bars: AuthoritativeBarV1[] = Array.from({ length: 20 }, (_, index) => {
  const timestamp = new Date(Date.parse("2026-01-02T14:30:00.000Z") + index * 300_000).toISOString()
  return {
    timestamp,
    sessionId: "2026-01-02",
    sessionOpen: "2026-01-02T14:30:00.000Z",
    sessionClose: "2026-01-02T16:05:00.000Z",
  }
})

const plan = compileExperimentPlanV1({
  request: {
    requestId: "request-operation",
    requestVersion: 1,
    requestHash: "request-hash",
    interval: "5min",
    requestedStart: bars[0].timestamp,
    requestedEnd: bars.at(-1)!.timestamp,
  },
  candidate: {
    candidateId: "candidate-operation",
    codeHash: qualificationHash("code"),
    configHash: qualificationHash("config"),
    warmupBars: 2,
    declaredSearchBudget: 20,
  },
  datasetEvidence: {
    datasetEvidenceId: "dataset-operation",
    datasetHash: "a".repeat(64),
    manifestHash: "b".repeat(64),
    qualification: "strict_qualified",
    actualStart: bars[0].timestamp,
    actualEnd: bars.at(-1)!.timestamp,
    interval: "5min",
    calendar: {
      calendarId: "XNYS",
      calendarVersion: "2026a",
      timezone: "America/New_York",
      scheduleHash: planHash(bars),
    },
    orderedBars: bars,
  },
  warmupBars: 2,
  declaredSearchBudget: 20,
  qualificationPolicy: DEFAULT_QUALIFICATION_POLICY_V1,
})

let home: string
const originalHome = process.env.FINNY_HOME

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "finny-qualification-operation-"))
  process.env.FINNY_HOME = home
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalHome
  await fs.rm(home, { recursive: true, force: true })
})

function durableInput() {
  return {
    policy: DEFAULT_QUALIFICATION_POLICY_V1,
    attemptLedger: DurableQualificationAttemptLedgerV1,
    executionIdentity: { codeHash: qualificationHash("code"), configHash: qualificationHash("config") },
  }
}

const event = makeHoldoutOpenEventV1({
  planId: plan.planId,
  planHash: plan.planHash,
  approvalHash: "c".repeat(64),
  openedAt: "2026-07-14T00:00:00.000Z",
})

const failedMetrics = {
  totalReturn: -0.01,
  sharpeRatio: -1,
  maxDrawdown: 0.1,
  totalTrades: 3,
  winRate: 0,
  finalEquity: 9900,
  v2: { run_metadata: {}, data_quality: { repair_applied: false } },
} as any

const passingPhaseMetrics = {
  ...failedMetrics,
  totalReturn: 0.05,
  sharpeRatio: 1.5,
  maxDrawdown: 0.05,
  totalTrades: 30,
  benchmarkReturn: 0.02,
  alpha: 0.03,
  finalEquity: 10500,
  sensitivityOutcomes: [{ name: "cost/slippage stress", status: "pass" }],
  v2: {
    run_metadata: {},
    data_quality: { repair_applied: false },
    walk_forward: { stitched_oos_return: 0.03 },
  },
} as any

describe("executeQualificationPlanV1", () => {
  test("owns the legal phase sequence and passes exact timestamp windows", async () => {
    const observed: Array<{ phase: string; start: string; end: string }> = []
    const result = await executeQualificationPlanV1({
      candidateId: "candidate-operation",
      plan,
      holdoutOpenEvents: [event],
      ...durableInput(),
      executePhase: async ({ phase, window }) => {
        observed.push({ phase, start: window.start, end: window.end })
        return { ok: true, results: phase === "confirmatory" ? failedMetrics : passingPhaseMetrics }
      },
    })
    expect(observed.map((item) => item.phase)).toEqual(["exploratory", "validation", "confirmatory"])
    expect(observed.map((item) => [item.start, item.end])).toEqual([
      [plan.windows.exploratory.start, plan.windows.exploratory.end],
      [plan.windows.validation.start, plan.windows.validation.end],
      [plan.windows.confirmatory.start, plan.windows.confirmatory.end],
    ])
    expect(result.ok).toBe(false)
    expect(result.completedPhases).toEqual(["exploratory", "validation", "confirmatory"])
  })

  test("returns one typed next transition before touching a sealed holdout", async () => {
    let executions = 0
    const result = await executeQualificationPlanV1({
      candidateId: "candidate-operation",
      plan,
      holdoutOpenEvents: [],
      ...durableInput(),
      executePhase: async () => {
        executions++
        return { ok: true, results: passingPhaseMetrics }
      },
    })
    expect(executions).toBe(2)
    expect(result).toMatchObject({
      ok: false,
      blocker: { code: "sealed_holdout_required", field: "holdoutOpenEvents" },
      completedPhases: ["exploratory", "validation"],
    })
  })

  test("does not execute confirmatory data for a tampered approval event", async () => {
    const phases: string[] = []
    const result = await executeQualificationPlanV1({
      candidateId: "candidate-operation",
      plan,
      holdoutOpenEvents: [{ ...event, approvalHash: "d".repeat(64) }],
      ...durableInput(),
      executePhase: async ({ phase }) => {
        phases.push(phase)
        return { ok: true, results: passingPhaseMetrics }
      },
    })
    expect(phases).toEqual(["exploratory", "validation"])
    expect(result).toMatchObject({ ok: false, blocker: { code: "sealed_holdout_required" } })
  })

  test("resumes completed phases and suppresses an unchanged failed attempt", async () => {
    const calls: string[] = []
    const executePhase = async ({ phase }: { phase: string }) => {
      calls.push(phase)
      if (phase === "validation") throw new Error("engine unavailable")
      return { ok: true as const, results: passingPhaseMetrics }
    }
    const first = await executeQualificationPlanV1({
      candidateId: "candidate-operation",
      plan,
      holdoutOpenEvents: [event],
      ...durableInput(),
      executePhase: executePhase as any,
    })
    const second = await executeQualificationPlanV1({
      candidateId: "candidate-operation",
      plan,
      holdoutOpenEvents: [event],
      ...durableInput(),
      executePhase: executePhase as any,
    })
    expect(first).toMatchObject({ ok: false, completedPhases: ["exploratory"] })
    expect(second).toMatchObject({ ok: false, completedPhases: ["exploratory"] })
    expect(calls).toEqual(["exploratory", "validation"])
    expect((await readQualificationAttemptEventsV1(plan.planId)).map((item) => item.event)).toEqual([
      "started", "completed", "started", "blocked",
    ])
  })

  test("durably records one stable preflight blocker across the eight-call audit trajectory", async () => {
    let executions = 0
    const wrongPolicy = makeQualificationPolicyV1({ minTrades: 31 })
    for (let call = 0; call < 8; call++) {
      const result = await executeQualificationPlanV1({
        candidateId: "candidate-operation",
        plan,
        holdoutOpenEvents: [event],
        ...durableInput(),
        policy: wrongPolicy,
        executePhase: async () => {
          executions++
          return { ok: true, results: failedMetrics }
        },
      })
      expect(result).toMatchObject({ ok: false, blocker: { code: "invalid_policy" }, completedPhases: [] })
    }
    expect(executions).toBe(0)
    const events = await readQualificationAttemptEventsV1(plan.planId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: "blocked", phase: "preflight", blocker: { code: "invalid_policy" } })
  })

  test("rejects attempt-ledger tampering", async () => {
    await executeQualificationPlanV1({
      candidateId: "candidate-operation",
      plan,
      holdoutOpenEvents: [event],
      ...durableInput(),
      policy: makeQualificationPolicyV1({ minTrades: 31 }),
      executePhase: async () => ({ ok: true, results: failedMetrics }),
    })
    const file = path.join(experimentRootDir(), plan.planId, "qualification-attempt-ledger.jsonl")
    const bytes = await fs.readFile(file, "utf8")
    await fs.writeFile(file, bytes.replace("invalid_policy", "quality_gates_failed"))
    await expect(readQualificationAttemptEventsV1(plan.planId)).rejects.toThrow("integrity verification")
  })

  test("keeps the holdout sealed through exploratory and validation, then resumes only confirmatory", async () => {
    let events: typeof event[] = []
    const phases: string[] = []
    let approvalRequests = 0
    let grantApproval = false
    const run = () => executeQualificationWithHoldoutApprovalV1({
      candidateId: "candidate-operation",
      plan,
      ...durableInput(),
      readHoldoutOpenEvents: async () => events,
      requestHoldoutApproval: async () => {
        approvalRequests++
        expect(events).toEqual([])
        expect(phases).toEqual(["exploratory", "validation"])
        if (!grantApproval) return false
        events = [event]
        return true
      },
      executePhase: async ({ phase }) => {
        phases.push(phase)
        if (phase !== "confirmatory") expect(events).toEqual([])
        else expect(events).toEqual([event])
        return { ok: true, results: passingPhaseMetrics }
      },
    })
    const rejected = await run()
    expect(events).toEqual([])
    expect(phases).toEqual(["exploratory", "validation"])
    expect(rejected).toMatchObject({ ok: false, blocker: { code: "sealed_holdout_required" } })
    grantApproval = true
    const result = await run()
    expect(approvalRequests).toBe(2)
    expect(phases).toEqual(["exploratory", "validation", "confirmatory"])
    expect(result.completedPhases).toEqual(["exploratory", "validation", "confirmatory"])
  })

  test("blocks failed validation metrics before requesting holdout approval", async () => {
    const phases: string[] = []
    let approvalRequests = 0
    const result = await executeQualificationWithHoldoutApprovalV1({
      candidateId: "candidate-operation",
      plan,
      ...durableInput(),
      readHoldoutOpenEvents: async () => [],
      requestHoldoutApproval: async () => {
        approvalRequests++
        return true
      },
      executePhase: async ({ phase }) => {
        phases.push(phase)
        return { ok: true, results: phase === "validation" ? failedMetrics : passingPhaseMetrics }
      },
    })
    expect(phases).toEqual(["exploratory", "validation"])
    expect(approvalRequests).toBe(0)
    expect(result).toMatchObject({
      ok: false,
      completedPhases: ["exploratory"],
      blocker: { code: "quality_gates_failed", field: "validation" },
    })
  })

  test("blocks a second candidate before any phase can use the first candidate plan", async () => {
    let executions = 0
    const result = await executeQualificationPlanV1({
      candidateId: "candidate-two",
      plan,
      policy: DEFAULT_QUALIFICATION_POLICY_V1,
      holdoutOpenEvents: [event],
      attemptLedger: DurableQualificationAttemptLedgerV1,
      executionIdentity: { codeHash: qualificationHash("other-code"), configHash: qualificationHash("other-config") },
      executePhase: async () => {
        executions++
        return { ok: true, results: failedMetrics }
      },
    })
    expect(executions).toBe(0)
    expect(result).toMatchObject({ ok: false, blocker: { field: "candidateId" }, completedPhases: [] })
  })
})
