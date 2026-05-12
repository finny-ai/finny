import { describe, expect, test } from "bun:test"
import { mkdir, rm, utimes, writeFile, readdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { Flock } from "../../src/util/flock"

const SCHEDULER_OPTS = {
  timeoutMs: 1,
  baseDelayMs: 1,
  maxDelayMs: 1,
  staleMs: 60_000 * 3,
}

async function tmpLockDir() {
  const dir = path.join(tmpdir(), `finny-flock-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

describe("Scheduler ownership lock recovery", () => {
  test("first acquisition succeeds on a clean dir", async () => {
    const dir = await tmpLockDir()
    try {
      const lease = await Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir })
      await lease.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a fresh lock from another owner blocks acquisition with timeoutMs:1", async () => {
    const dir = await tmpLockDir()
    try {
      const first = await Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir })
      await expect(
        Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir }),
      ).rejects.toThrow(/Timed out waiting for lock/)
      await first.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a stale lock dir (orphaned heartbeat older than staleMs) is broken on retry", async () => {
    const dir = await tmpLockDir()
    try {
      // Simulate a previous TUI process that died holding the lock: the lock dir
      // exists with a meta + heartbeat, but neither file has been touched in
      // longer than staleMs. This is exactly the failure mode the user hit.
      const entries = await readdir(dir)
      expect(entries.length).toBe(0)

      // Acquire once to create the canonical layout, then forcibly age the files.
      const orphan = await Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir })
      // Drop the lease object reference without calling release, simulating crash.
      void orphan

      // Find the lock dir Flock created and age every file inside it.
      const lockDirs = (await readdir(dir)).filter((e) => e.endsWith(".lock"))
      expect(lockDirs.length).toBe(1)
      const lockDir = path.join(dir, lockDirs[0]!)
      const ageBy = SCHEDULER_OPTS.staleMs + 60_000
      const ancient = new Date(Date.now() - ageBy)
      for (const f of await readdir(lockDir)) {
        await utimes(path.join(lockDir, f), ancient, ancient)
      }
      await utimes(lockDir, ancient, ancient)

      // A fresh acquisition must now break the stale lock and succeed without
      // any retry loop in the caller — Flock.acquire's internal staleness sweep
      // handles it. This is the contract Scheduler.start now relies on across
      // ticks instead of on the first call alone.
      const recovered = await Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir })
      await recovered.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("after a failed first attempt, a later attempt succeeds once the prior owner releases", async () => {
    // This documents the new Scheduler.start retry contract: the timer wakes
    // every TICK_MS and re-runs attemptOwnership when not yet owner, so a second
    // TUI that lost the race at boot will pick up ownership when the holder exits.
    const dir = await tmpLockDir()
    try {
      const holder = await Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir })
      await expect(
        Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir }),
      ).rejects.toThrow(/Timed out waiting for lock/)

      await holder.release()

      const second = await Flock.acquire("cron:scheduler:owner", { ...SCHEDULER_OPTS, dir })
      await second.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// Avoid unused-import lint when only some helpers are exercised in a slim test set.
void writeFile
