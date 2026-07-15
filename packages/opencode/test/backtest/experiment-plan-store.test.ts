import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compileExperimentPlanV1, planHash, type AuthoritativeBarV1 } from "../../src/backtest/experiment-plan"
import {
  loadExperimentPlanV1,
  loadExperimentPlanPolicyV1,
  readHoldoutOpenEventsV1,
  recordHoldoutOpenEventV1,
  saveExperimentPlanV1,
} from "../../src/backtest/experiment-plan-store"
import { DEFAULT_QUALIFICATION_POLICY_V1 } from "../../src/backtest/qualification-policy"

const originalHome = process.env.FINNY_HOME
const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalHome
})

function compiledPlan() {
  const bars: AuthoritativeBarV1[] = Array.from({ length: 20 }, (_, index) => {
    const timestamp = new Date(Date.parse("2026-01-02T14:30:00.000Z") + index * 300_000).toISOString()
    return {
      timestamp,
      sessionId: "2026-01-02",
      sessionOpen: "2026-01-02T14:30:00.000Z",
      sessionClose: "2026-01-02T16:05:00.000Z",
    }
  })
  return compileExperimentPlanV1({
    request: {
      requestId: "request-store",
      requestVersion: 1,
      requestHash: "request-hash",
      interval: "5min",
      requestedStart: bars[0].timestamp,
      requestedEnd: bars.at(-1)!.timestamp,
    },
    candidate: {
      candidateId: "candidate-store",
      codeHash: "c".repeat(64),
      configHash: "d".repeat(64),
      warmupBars: 2,
      declaredSearchBudget: 20,
    },
    datasetEvidence: {
      datasetEvidenceId: "dataset-store",
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
}

describe("ExperimentPlanV1 durable store", () => {
  test("persists immutable plans and exactly one approved holdout-open event", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "finny-plan-store-"))
    cleanups.push(home)
    process.env.FINNY_HOME = home
    const plan = compiledPlan()
    await saveExperimentPlanV1(plan, DEFAULT_QUALIFICATION_POLICY_V1)
    expect(await loadExperimentPlanV1(plan.planId)).toEqual(plan)
    expect(await loadExperimentPlanPolicyV1(plan.planId)).toEqual(DEFAULT_QUALIFICATION_POLICY_V1)
    const event = await recordHoldoutOpenEventV1({
      plan,
      approvalHash: "c".repeat(64),
      openedAt: "2026-07-14T00:00:00.000Z",
    })
    expect(await readHoldoutOpenEventsV1(plan.planId)).toEqual([event])
    await expect(recordHoldoutOpenEventV1({ plan, approvalHash: "d".repeat(64) })).rejects.toThrow()
    expect(await readHoldoutOpenEventsV1(plan.planId)).toHaveLength(1)
  })
})
