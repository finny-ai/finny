import { describe, expect, test } from "bun:test"
import { WatcherState } from "../../src/cron/watcher-state"

describe("WatcherState", () => {
  test("create, update, and read round trip", () => {
    const jobID = `job_${crypto.randomUUID()}`
    const created = WatcherState.upsert({
      jobID,
      parentSessionID: "ses_parent",
      algorithmID: "algo_1",
      algorithmName: "mean-reversion",
    })

    expect(created.jobID).toBe(jobID)
    expect(created.parentSessionID).toBe("ses_parent")
    expect(created.algorithmID).toBe("algo_1")

    const snapshot = WatcherState.recordSnapshot(jobID, {
      price: 100,
      equity: 10_000,
      positionQty: 0,
      at: 123,
    })

    expect(snapshot?.baselinePrice).toBe(100)
    expect(snapshot?.lastPrice).toBe(100)
    expect(snapshot?.baselineEquity).toBe(10_000)
    expect(snapshot?.lastSnapshotAt).toBe(123)
  })

  test("pending finding survives a fresh read and can be finalized", () => {
    const jobID = `job_${crypto.randomUUID()}`
    WatcherState.upsert({
      jobID,
      parentSessionID: "ses_parent",
      algorithmID: "algo_2",
      algorithmName: "breakout",
    })

    WatcherState.markPending(jobID, "[watcher: breakout]\n\nMaterial move.")

    const pending = WatcherState.listPending().find((item) => item.jobID === jobID)
    expect(pending?.pendingStatus).toBe(WatcherState.PendingStatus.pending)
    expect(pending?.pendingFinding).toContain("Material move")

    WatcherState.markDelivered(jobID)
    const delivered = WatcherState.get(jobID)
    expect(delivered?.pendingStatus).toBe(WatcherState.PendingStatus.delivered)
    expect(delivered?.pendingDeliveredAt).toBeNumber()
  })

  test("missing watcher state is safe for old jobs", () => {
    expect(WatcherState.get(`missing_${crypto.randomUUID()}`)).toBeUndefined()
  })

  test("markPending appends instead of clobbering when a prior pending finding is still undelivered", () => {
    const jobID = `job_${crypto.randomUUID()}`
    WatcherState.upsert({ jobID, parentSessionID: "ses_parent", algorithmName: "double-tick" })
    WatcherState.markPending(jobID, "first finding")
    WatcherState.markPending(jobID, "second finding")

    const state = WatcherState.get(jobID)
    expect(state?.pendingStatus).toBe(WatcherState.PendingStatus.pending)
    expect(state?.pendingFinding).toContain("first finding")
    expect(state?.pendingFinding).toContain("second finding")
    expect(state?.pendingFinding).toContain("---")
  })

  test("markPending overwrites a delivered finding (terminal state, safe to replace)", () => {
    const jobID = `job_${crypto.randomUUID()}`
    WatcherState.upsert({ jobID, parentSessionID: "ses_parent", algorithmName: "post-delivery" })
    WatcherState.markPending(jobID, "first finding")
    WatcherState.markDelivered(jobID)
    WatcherState.markPending(jobID, "next finding")

    const state = WatcherState.get(jobID)
    expect(state?.pendingFinding).toBe("next finding")
    expect(state?.pendingFinding).not.toContain("first finding")
  })
})
