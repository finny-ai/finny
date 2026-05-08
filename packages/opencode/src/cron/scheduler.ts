import { Log } from "../util/log"
import { CronStorage } from "./storage"
import { Schedule } from "./schedule"
import { Check } from "./check"
import { Notify } from "./notify"
import { PromptRunner } from "./prompt-runner"
import { ulid } from "ulid"
import { Job } from "./job"
import { Inject } from "./inject"
import { Flock } from "@/util/flock"
import { WatcherEvaluator } from "./watcher-evaluator"
import { WatcherState } from "./watcher-state"

export namespace Scheduler {
  const log = Log.create({ service: "cron.scheduler" })
  const FAILURE_LIMIT = 5
  const TICK_MS = 60_000
  const LOCK_KEY = "cron:scheduler:owner"

  let timer: ReturnType<typeof setInterval> | undefined
  let owner: Flock.Lease | undefined
  let running = false

  export function start() {
    if (timer || owner) return
    log.info("scheduler.start")
    void Flock.acquire(LOCK_KEY, { timeoutMs: 1, baseDelayMs: 1, maxDelayMs: 1, staleMs: TICK_MS * 3 })
      .then((lease) => {
        owner = lease
        void bootSweep().catch((e) => log.error("scheduler.boot-sweep.error", { e: String(e) }))
        void Inject.retryPending().catch((e) => log.error("scheduler.retry-pending.error", { e: String(e) }))
        void tick().catch((e) => log.error("scheduler.tick.error", { e: String(e) }))
        timer = setInterval(() => {
          void tick().catch((e) => log.error("scheduler.tick.error", { e: String(e) }))
        }, TICK_MS)
      })
      .catch((e) => log.info("scheduler.no-ownership", { e: String(e) }))
  }

  export function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
    const current = owner
    owner = undefined
    void current?.release().catch((e) => log.warn("scheduler.release.failed", { e: String(e) }))
    log.info("scheduler.stop")
  }

  export function isStarted() {
    return !!timer
  }

  async function bootSweep() {
    const jobs = await CronStorage.list()
    for (const job of jobs) {
      if (job.durable || !job.parentSessionID) continue
      await CronStorage.remove(job.id)
      log.info("scheduler.boot-sweep.removed", { jobId: job.id })
    }
  }

  async function tick() {
    if (running) {
      log.debug("scheduler.tick.skipped", { reason: "previous tick still running" })
      return
    }
    running = true
    try {
      const now = new Date()
      const jobs = await CronStorage.list()
      for (const job of jobs) {
        if (!job.enabled) continue
        if (!Schedule.matches(job.schedule, now, job.timezone)) continue
        // TODO Phase 5: skip on closed market days when job.marketAware
        await runJob(job, now)
      }
    } finally {
      running = false
    }
  }

  /** Public — fire a job once on demand, ignoring schedule. Used by `cron run <id>`. */
  export async function runOnce(jobId: string): Promise<CronStorage.RunRecord> {
    const job = await CronStorage.get(jobId)
    if (!job) throw new Error(`job not found: ${jobId}`)
    return await runJob(job, new Date())
  }

  async function runJob(job: Job.Schema, when: Date): Promise<CronStorage.RunRecord> {
    const startedAt = Date.now()
    let status: CronStorage.RunRecord["status"] = "ok"
    let note: string | undefined
    try {
      if (job.expiresAt && job.expiresAt <= startedAt) {
        await CronStorage.update(job.id, { enabled: false })
        status = "skipped"
        note = "expired"
      } else if (job.kind === "check") {
        if (Check.withinCooldown(job, startedAt)) {
          status = "skipped"
          note = "within cooldown"
        } else {
          const result = await Check.evaluate(job)
          note = result.note
          if (result.fired) {
            status = "fired"
            await Notify.send({
              title: job.notification.title || job.name,
              body: job.notification.body || result.summary || result.note,
            })
            await CronStorage.update(job.id, { lastFiredAt: startedAt })
          }
        }
      } else if (job.kind === "prompt") {
        const decision = await WatcherEvaluator.evaluate(job)
        if (decision.kind === "skip") {
          status = "skipped"
          note = decision.note
          await CronStorage.update(job.id, { lastRunAt: startedAt, failureCount: 0, lastError: undefined })
        } else if (decision.kind === "unavailable") {
          status = "error"
          note = decision.note
          const failureCount = (job.failureCount ?? 0) + 1
          await CronStorage.update(job.id, {
            lastRunAt: startedAt,
            lastError: note,
            failureCount,
          })
          if (failureCount >= FAILURE_LIMIT) {
            await CronStorage.update(job.id, { enabled: false })
            await Notify.send({
              title: "Finny job auto-paused",
              body: `"${job.name}" was disabled after ${FAILURE_LIMIT} consecutive failures.`,
            })
          }
        }
        if (decision.kind !== "run") {
          const finishedAt = Date.now()
          const record: CronStorage.RunRecord = {
            id: ulid(),
            jobId: job.id,
            startedAt,
            finishedAt,
            status,
            note,
            durationMs: finishedAt - startedAt,
          }
          await CronStorage.appendRun(record)
          log.info("scheduler.run", { jobId: job.id, status, ms: record.durationMs })
          return record
        }
        const result = await PromptRunner.run(job)
        if (result.ok && result.text) {
          const text = result.text.trim()
          if (text === "No change.") {
            status = "ok"
            note = "watcher found no material change"
          } else {
            status = "fired"
            note = "prompt completed"
            if (job.parentSessionID) {
              const finding = formatFinding(job, text)
              WatcherState.recordSnapshot(job.id, { material: true })
              WatcherState.markPending(job.id, finding)
              await Inject.post(job.parentSessionID, finding, {
                title: job.notification.title || job.name,
                pendingJobID: job.id,
              })
            } else {
              await Notify.send({
                title: job.notification.title || job.name,
                body: (job.notification.body || text).slice(0, 240),
              })
            }
            await CronStorage.update(job.id, { lastFiredAt: startedAt })
          }
        } else {
          status = "error"
          note = result.error || "prompt failed"
        }
      }
      await CronStorage.update(job.id, {
        lastRunAt: startedAt,
        lastError: status === "error" ? note : undefined,
        failureCount: status === "error" ? (job.failureCount ?? 0) + 1 : 0,
      })

      if (status === "error" && (job.failureCount ?? 0) + 1 >= FAILURE_LIMIT) {
        await CronStorage.update(job.id, { enabled: false })
        await Notify.send({
          title: "Finny job auto-paused",
          body: `"${job.name}" was disabled after ${FAILURE_LIMIT} consecutive failures.`,
        })
        log.warn("scheduler.autopaused", { jobId: job.id })
      }
    } catch (err) {
      status = "error"
      note = `unhandled: ${String(err)}`
      await CronStorage.update(job.id, {
        lastRunAt: startedAt,
        lastError: note,
        failureCount: (job.failureCount ?? 0) + 1,
      })
    }
    const finishedAt = Date.now()
    const record: CronStorage.RunRecord = {
      id: ulid(),
      jobId: job.id,
      startedAt,
      finishedAt,
      status,
      note,
      durationMs: finishedAt - startedAt,
    }
    await CronStorage.appendRun(record)
    log.info("scheduler.run", { jobId: job.id, status, ms: record.durationMs })
    return record
  }

  function formatFinding(job: Job.Schema, text: string) {
    return [`[watcher: ${job.name}]`, text].join("\n\n")
  }
}
