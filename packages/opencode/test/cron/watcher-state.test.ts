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
})
