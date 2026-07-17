import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  beginTrial,
  completeTrial,
  ExperimentContractError,
  experimentRootDir,
  readTrialEvents,
} from "../../src/backtest/experiment"

let home: string
let previousHome: string | undefined

function algorithm(name: string, version = 1) {
  return {
    algorithmId: `algo-${name.replace(/[^a-z0-9]/g, "-")}`,
    name,
    version,
    code: `class Strategy:\n    pass\n# ${name}`,
    config: JSON.stringify({ symbol: "SPY", execution: { fee_bps: 2, slippage_bps: 1 } }),
  }
}

const boundaries = {
  trainStart: "2020-01-01",
  trainEnd: "2022-01-01",
  validationEnd: "2023-01-01",
  testEnd: "2024-01-01",
}

beforeEach(async () => {
  previousHome = process.env.FINNY_HOME
  home = await fs.mkdtemp(path.join(os.tmpdir(), "finny-experiment-ledger-"))
  process.env.FINNY_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = previousHome
  await fs.rm(home, { recursive: true, force: true })
})

describe("durable ExperimentSpec and trial ledger", () => {
  test("counts the same economic hypothesis across sessions and renamed algorithms", async () => {
    const first = await beginTrial({
      algorithm: algorithm("spy-momentum"),
      interval: "1d",
      startDate: "2020-01-01",
      endDate: "2022-01-01",
      sessionId: "session-one",
      experiment: { experimentId: "economic-spy-momentum", hypothesis: "SPY momentum persists", boundaries },
    })
    await completeTrial({
      reference: first.reference,
      sessionId: "session-one",
      algorithm: algorithm("spy-momentum"),
      outcome: "failed",
    })

    const renamed = await beginTrial({
      algorithm: algorithm("spy-breakout-renamed"),
      interval: "1d",
      startDate: "2020-01-01",
      endDate: "2022-01-01",
      sessionId: "session-two",
      experiment: { experimentId: "economic-spy-momentum", hypothesis: "SPY momentum persists", boundaries },
    })

    expect(renamed.reference.trialNumber).toBe(2)
    expect(renamed.priorConsecutiveFailures).toBe(1)
    expect((await readTrialEvents({ experimentId: "economic-spy-momentum" })).map((event) => event.event)).toEqual([
      "started",
      "completed",
      "started",
    ])
  })

  test("freezes observed boundaries and requires a descendant lineage for changes", async () => {
    await beginTrial({
      algorithm: algorithm("frozen-contract"),
      interval: "1d",
      startDate: "2020-01-01",
      endDate: "2022-01-01",
      sessionId: "session-one",
      experiment: { experimentId: "frozen-contract-v1", hypothesis: "Frozen contract", boundaries },
    })

    await expect(
      beginTrial({
        algorithm: algorithm("frozen-contract", 2),
        interval: "1d",
        startDate: "2020-01-01",
        endDate: "2022-06-01",
        sessionId: "session-two",
        experiment: {
          experimentId: "frozen-contract-v1",
          hypothesis: "Frozen contract",
          boundaries: { ...boundaries, trainEnd: "2022-06-01" },
        },
      }),
    ).rejects.toBeInstanceOf(ExperimentContractError)

    const descendant = await beginTrial({
      algorithm: algorithm("frozen-contract", 2),
      interval: "1d",
      startDate: "2020-01-01",
      endDate: "2022-06-01",
      sessionId: "session-two",
      experiment: {
        experimentId: "frozen-contract-v2",
        parentExperimentId: "frozen-contract-v1",
        hypothesis: "Frozen contract",
        boundaries: { ...boundaries, trainEnd: "2022-06-01" },
      },
    })
    expect(descendant.spec.parentExperimentId).toBe("frozen-contract-v1")
  })

  test("blocks holdout peeking and records one-way explicit access", async () => {
    const base = {
      algorithm: algorithm("sealed-holdout"),
      interval: "1d",
      startDate: "2023-01-01",
      endDate: "2024-01-01",
      sessionId: "confirmatory-session",
    }
    const experiment = {
      experimentId: "sealed-holdout-exp",
      hypothesis: "Sealed holdout hypothesis",
      boundaries,
      phase: "confirmatory" as const,
    }

    await expect(beginTrial({ ...base, experiment })).rejects.toThrow("requires holdoutApproved")
    const opened = await beginTrial({
      ...base,
      experiment: { ...experiment, holdoutApproved: true, approvalReason: "Human approved the single final test" },
    })
    expect(opened.reference.phase).toBe("confirmatory")
    const audit = JSON.parse(
      await fs.readFile(path.join(experimentRootDir(), "sealed-holdout-exp", "holdout-access.json"), "utf8"),
    )
    expect(audit).toMatchObject({ approved: true, trialId: opened.reference.trialId })

    await expect(
      beginTrial({
        ...base,
        sessionId: "another-session",
        experiment: { ...experiment, holdoutApproved: true, approvalReason: "Try again" },
      }),
    ).rejects.toThrow("already been opened")
  })

  test("rejects validation trajectories that cross into the test window", async () => {
    await expect(
      beginTrial({
        algorithm: algorithm("peek-at-test"),
        interval: "1d",
        startDate: "2020-01-01",
        endDate: "2023-06-01",
        sessionId: "validation-session",
        experiment: {
          experimentId: "holdout-peeking-trajectory",
          hypothesis: "Do not peek",
          boundaries,
          phase: "validation",
        },
      }),
    ).rejects.toThrow("cannot observe the sealed test window")

    await expect(
      beginTrial({
        algorithm: algorithm("boundary-overlap"),
        interval: "1d",
        startDate: "2020-01-01",
        endDate: "2023-01-01",
        sessionId: "boundary-session",
        experiment: {
          experimentId: "holdout-boundary-overlap",
          hypothesis: "Do not share a holdout bar",
          boundaries,
          phase: "validation",
        },
      }),
    ).rejects.toThrow("cannot observe the sealed test window")
  })

  test("atomically permits only one concurrent confirmatory holdout claim", async () => {
    const request = {
      algorithm: algorithm("concurrent-holdout"),
      interval: "1d",
      startDate: "2023-01-01",
      endDate: "2024-01-01",
      experiment: {
        experimentId: "concurrent-holdout-exp",
        hypothesis: "Concurrent holdout hypothesis",
        boundaries,
        phase: "confirmatory" as const,
        holdoutApproved: true,
        approvalReason: "Approve one atomic claim",
      },
    }
    const attempts = await Promise.allSettled([
      beginTrial({ ...request, sessionId: "session-a" }),
      beginTrial({ ...request, sessionId: "session-b" }),
    ])

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1)
    expect(
      (await readTrialEvents({ experimentId: "concurrent-holdout-exp" })).filter((event) => event.event === "started"),
    ).toHaveLength(1)
  })

  test("allocates unique trial numbers and keeps failure-budget blocks in the streak", async () => {
    const request = {
      algorithm: algorithm("concurrent-trials"),
      interval: "1d",
      startDate: "2020-01-01",
      endDate: "2022-01-01",
      experiment: { experimentId: "concurrent-trials-exp", hypothesis: "Concurrent trials", boundaries },
    }
    const attempts = await Promise.all([
      beginTrial({ ...request, sessionId: "session-a" }),
      beginTrial({ ...request, sessionId: "session-b" }),
    ])
    expect(attempts.map((attempt) => attempt.reference.trialNumber).sort()).toEqual([1, 2])
    for (const attempt of attempts) {
      await completeTrial({
        reference: attempt.reference,
        sessionId: attempt.reference.trialId,
        algorithm: request.algorithm,
        outcome: "failed",
        actualDataHash: "hash-one",
      })
    }
    const blocked = await beginTrial({ ...request, sessionId: "session-c" })
    await completeTrial({
      reference: blocked.reference,
      sessionId: "session-c",
      algorithm: request.algorithm,
      outcome: "blocked",
      actualDataHash: "hash-one",
    })
    const next = await beginTrial({ ...request, sessionId: "session-d" })
    expect(next.priorConsecutiveFailures).toBe(2)
  })

  test("binds an automatic data snapshot on first completion and rejects a changed rerun", async () => {
    const request = {
      algorithm: algorithm("data-snapshot"),
      interval: "1d",
      startDate: "2020-01-01",
      endDate: "2022-01-01",
      sessionId: "session-one",
      experiment: { experimentId: "data-snapshot-exp", hypothesis: "Stable source data", boundaries },
    }
    const first = await beginTrial(request)
    await completeTrial({
      reference: first.reference,
      sessionId: "session-one",
      algorithm: request.algorithm,
      outcome: "passed",
      actualDataHash: "hash-one",
    })
    const rerun = await beginTrial({ ...request, sessionId: "session-two" })
    await expect(
      completeTrial({
        reference: rerun.reference,
        sessionId: "session-two",
        algorithm: request.algorithm,
        outcome: "passed",
        actualDataHash: "hash-two",
      }),
    ).rejects.toThrow("first observed experiment data snapshot")
  })

  test("runtime owns the data snapshot when scientific input contains prose", async () => {
    const request = {
      algorithm: algorithm("runtime-owned-snapshot"),
      interval: "1d",
      startDate: "2025-07-15",
      endDate: "2026-07-15",
      sessionId: "session-runtime-snapshot",
      experiment: {
        experimentId: "runtime-owned-snapshot-exp",
        hypothesis: "Stable BTC source data",
        dataSnapshot: "Exact BTC daily window 2025-07-15 to 2026-07-15",
      },
    }
    const trial = await beginTrial(request)
    expect(trial.spec.dataSnapshot).toBe("engine-data-hash-bound-at-completion")
    await expect(
      completeTrial({
        reference: trial.reference,
        sessionId: request.sessionId,
        algorithm: request.algorithm,
        outcome: "passed",
        actualDataHash: "actual-engine-data-hash",
      }),
    ).resolves.toBeUndefined()
  })
})
