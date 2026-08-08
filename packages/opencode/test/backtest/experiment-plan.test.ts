import { describe, expect, test } from "bun:test"
import {
  compileExperimentPlanV1,
  candidateMatchesExperimentPlanV1,
  planHash,
  verifyExperimentPlanV1,
  type AuthoritativeBarV1,
  type CompileExperimentPlanInput,
} from "../../src/backtest/experiment-plan"
import {
  DEFAULT_QUALIFICATION_POLICY_V1,
  EXPLORATORY_QUALIFICATION_POLICY_V1,
} from "../../src/backtest/qualification-policy"

function bar(timestamp: string, sessionId: string, sessionOpen: string, sessionClose: string): AuthoritativeBarV1 {
  return { timestamp, sessionId, sessionOpen, sessionClose }
}

function intradaySession(input: { id: string; open: string; bars: number; minutes?: number }): AuthoritativeBarV1[] {
  const step = input.minutes ?? 5
  const open = Date.parse(input.open)
  const close = new Date(open + (input.bars - 1) * step * 60_000).toISOString()
  return Array.from({ length: input.bars }, (_, index) =>
    bar(new Date(open + index * step * 60_000).toISOString(), input.id, input.open, close),
  )
}

function input(
  bars: AuthoritativeBarV1[],
  overrides: Partial<CompileExperimentPlanInput> = {},
): CompileExperimentPlanInput {
  const calendar = {
    calendarId: "XNYS",
    calendarVersion: "2026a",
    timezone: "America/New_York",
    scheduleHash: planHash(bars),
  }
  return {
    request: {
      requestId: "request-authoritative-bars",
      requestVersion: 1,
      requestHash: "request-hash",
      interval: "5min",
      requestedStart: bars[0].timestamp,
      requestedEnd: bars.at(-1)!.timestamp,
    },
    candidate: {
      candidateId: "candidate-authoritative-bars",
      codeHash: "c".repeat(64),
      configHash: "d".repeat(64),
      warmupBars: overrides.warmupBars ?? 1,
      declaredSearchBudget: overrides.declaredSearchBudget ?? 20,
    },
    datasetEvidence: {
      datasetEvidenceId: "dataset-authoritative-bars",
      datasetHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      qualification: "strict_qualified",
      actualStart: bars[0].timestamp,
      actualEnd: bars.at(-1)!.timestamp,
      interval: "5min",
      calendar,
      orderedBars: bars,
    },
    warmupBars: 1,
    declaredSearchBudget: 20,
    qualificationPolicy: DEFAULT_QUALIFICATION_POLICY_V1,
    ...overrides,
  }
}

describe("ExperimentPlanV1 compiler", () => {
  test("refuses to bind an exploratory preset to a confirmatory qualification plan", () => {
    const bars = intradaySession({ id: "2026-01-09", open: "2026-01-09T14:30:00.000Z", bars: 16 })
    expect(() =>
      compileExperimentPlanV1(input(bars, { qualificationPolicy: EXPLORATORY_QUALIFICATION_POLICY_V1 })),
    ).toThrow("must require the confirmatory phase")
  })

  test("accepts date-only coverage beginning at the first authoritative session bar", () => {
    const bars = [
      ...intradaySession({ id: "2026-01-09", open: "2026-01-09T14:30:00.000Z", bars: 8 }),
      ...intradaySession({ id: "2026-01-12", open: "2026-01-12T14:30:00.000Z", bars: 8 }),
    ]
    const base = input(bars)
    const plan = compileExperimentPlanV1({
      ...base,
      request: { ...base.request, requestedStart: "2026-01-09", requestedEnd: "2026-01-12" },
    })
    expect(plan.barCount).toBe(16)
    expect(plan.windows.warmup.start).toBe("2026-01-09T14:30:00.000Z")
  })

  test("retains exact coverage semantics for timestamp request bounds", () => {
    const bars = intradaySession({ id: "2026-01-09", open: "2026-01-09T14:30:00.000Z", bars: 16 })
    const base = input(bars)
    expect(() => compileExperimentPlanV1({
      ...base,
      request: { ...base.request, requestedStart: "2026-01-09T14:29:00.000Z" },
    })).toThrow("dataset evidence does not cover the requested range")
  })

  test("uses the authoritative NYSE schedule and skips a market holiday", () => {
    const bars = [
      ...intradaySession({ id: "2025-12-24", open: "2025-12-24T14:30:00.000Z", bars: 8 }),
      ...intradaySession({ id: "2025-12-26", open: "2025-12-26T14:30:00.000Z", bars: 8 }),
    ]
    const plan = compileExperimentPlanV1(input(bars))
    expect(verifyExperimentPlanV1(plan)).toEqual([])
    expect(JSON.stringify(plan.windows)).not.toContain("2025-12-25")
    expect(plan.datasetEvidence.calendar).toMatchObject({ calendarId: "XNYS", calendarVersion: "2026a" })
    expect(plan.barScheduleHash).toBe(planHash(bars))
  })

  test("counts a 200-bar intraday warmup as bars across full and half-day sessions", () => {
    const bars = [
      ...intradaySession({ id: "full-1", open: "2025-11-26T14:30:00.000Z", bars: 78 }),
      ...intradaySession({ id: "half-day", open: "2025-11-28T14:30:00.000Z", bars: 42 }),
      ...intradaySession({ id: "full-2", open: "2025-12-01T14:30:00.000Z", bars: 78 }),
      ...intradaySession({ id: "full-3", open: "2025-12-02T14:30:00.000Z", bars: 78 }),
      ...intradaySession({ id: "full-4", open: "2025-12-03T14:30:00.000Z", bars: 78 }),
      ...intradaySession({ id: "full-5", open: "2025-12-04T14:30:00.000Z", bars: 78 }),
    ]
    const plan = compileExperimentPlanV1(input(bars, { warmupBars: 200 }))
    expect(plan.windows.warmup.bars).toBe(200)
    expect(plan.windows.warmup.sessions).toBe(4)
    expect(plan.windows.warmup.end).toBe(bars[199].timestamp)
    expect(plan.windows.exploratory.start).toBe(bars[200].timestamp)
  })

  test("preserves authoritative DST-shifted equity timestamps", () => {
    const bars = [
      ...intradaySession({ id: "pre-dst", open: "2025-03-07T14:30:00.000Z", bars: 8 }),
      ...intradaySession({ id: "post-dst", open: "2025-03-10T13:30:00.000Z", bars: 8 }),
    ]
    const plan = compileExperimentPlanV1(input(bars))
    expect(plan.windows.confirmatory.end).toBe(bars.at(-1)!.timestamp)
    expect(JSON.stringify(plan.windows)).toContain("13:35:00.000Z")
  })

  test("preserves overnight futures session identities", () => {
    const bars = [
      ...intradaySession({ id: "CME-2025-03-10", open: "2025-03-09T22:00:00.000Z", bars: 12, minutes: 60 }),
      ...intradaySession({ id: "CME-2025-03-11", open: "2025-03-10T22:00:00.000Z", bars: 12, minutes: 60 }),
    ]
    const plan = compileExperimentPlanV1(
      input(bars, {
        datasetEvidence: {
          ...input(bars).datasetEvidence,
          calendar: {
            calendarId: "CMES",
            calendarVersion: "2026a",
            timezone: "America/Chicago",
            scheduleHash: planHash(bars),
          },
        },
      }),
    )
    expect(verifyExperimentPlanV1(plan)).toEqual([])
    expect(plan.windows.warmup.firstSessionId).toBe("CME-2025-03-10")
  })

  test("uses weekend crypto bars from a versioned 24/7 calendar", () => {
    const bars = intradaySession({ id: "crypto-continuous", open: "2025-03-08T00:00:00.000Z", bars: 24, minutes: 60 })
    const base = input(bars)
    const plan = compileExperimentPlanV1({
      ...base,
      datasetEvidence: {
        ...base.datasetEvidence,
        calendar: { calendarId: "CRYPTO_24_7", calendarVersion: "1", timezone: "UTC", scheduleHash: planHash(bars) },
      },
    })
    expect(plan.windows.exploratory.start.startsWith("2025-03-08")).toBe(true)
  })

  test("fails closed on schedule or plan tampering", () => {
    const bars = intradaySession({ id: "session", open: "2025-01-02T14:30:00.000Z", bars: 20 })
    expect(() =>
      compileExperimentPlanV1({
        ...input(bars),
        datasetEvidence: {
          ...input(bars).datasetEvidence,
          calendar: { ...input(bars).datasetEvidence.calendar, scheduleHash: "c".repeat(64) },
        },
      }),
    ).toThrow("schedule hash mismatch")
    const plan = compileExperimentPlanV1(input(bars))
    expect(verifyExperimentPlanV1({ ...plan, barCount: plan.barCount + 1 }).join(" ")).toContain("hash mismatch")
  })

  test("rejects substituting a second candidate against the first candidate plan", () => {
    const bars = intradaySession({ id: "session", open: "2025-01-02T14:30:00.000Z", bars: 20 })
    const first = compileExperimentPlanV1(input(bars))
    const secondIdentity = {
      candidateId: "candidate-two",
      codeHash: "e".repeat(64),
      configHash: "f".repeat(64),
    }
    const second = compileExperimentPlanV1(input(bars, {
      candidate: {
        ...secondIdentity,
        warmupBars: 1,
        declaredSearchBudget: 20,
      },
    }))
    expect(first.planId).not.toBe(second.planId)
    expect(candidateMatchesExperimentPlanV1({ plan: first, ...first.candidate })).toBe(true)
    expect(candidateMatchesExperimentPlanV1({ plan: first, ...secondIdentity })).toBe(false)
  })
})
