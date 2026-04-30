import path from "path"
import fs from "fs/promises"
import { ulid } from "ulid"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Flock } from "../util/flock"
import { Log } from "../util/log"
import { Job } from "./job"

export namespace CronStorage {
  const log = Log.create({ service: "cron.storage" })
  const dir = () => path.join(Global.Path.data, "cron")
  const file = () => path.join(dir(), "jobs.json")
  const runsDir = () => path.join(Global.Path.data, "cron", "runs")
  const LOCK_KEY = () => `cron:jobs:${file()}`
  // Soft cap on per-run-log size we read into memory. Older entries are still
  // on disk; logs subcommand just shows the most recent slice.
  const TAIL_READ_CAP_BYTES = 1_000_000

  type Bundle = { version: 1; jobs: Job.Schema[] }

  async function backupRaw(raw: string, reason: string): Promise<void> {
    try {
      await fs.mkdir(dir(), { recursive: true })
      const target = path.join(dir(), `jobs.json.invalid-${reason}.${Date.now()}`)
      await fs.writeFile(target, raw)
      log.warn("storage.backed-up-invalid", { target, reason })
    } catch (err) {
      log.error("storage.backup-failed", { reason, err: String(err) })
    }
  }

  /**
   * Read jobs.json defensively. If the file is corrupt at the JSON level, or
   * individual jobs fail schema validation, preserve the original bytes as a
   * timestamped `.invalid-*` backup before continuing — this prevents the
   * next save() from silently overwriting the real data with an empty list.
   */
  async function load(): Promise<Bundle> {
    const raw = await Filesystem.readText(file()).catch(() => undefined)
    if (!raw) return { version: 1, jobs: [] }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await backupRaw(raw, "json")
      return { version: 1, jobs: [] }
    }

    const rawJobs = Array.isArray((parsed as any)?.jobs) ? (parsed as any).jobs : []
    const jobs: Job.Schema[] = []
    let invalid = 0
    for (const j of rawJobs) {
      const result = Job.Schema.safeParse(j)
      if (result.success) jobs.push(result.data)
      else {
        invalid++
        log.warn("storage.invalid-job-skipped", { error: result.error.message.slice(0, 200) })
      }
    }
    if (invalid > 0) await backupRaw(raw, "schema")
    return { version: 1, jobs }
  }

  async function save(bundle: Bundle) {
    await fs.mkdir(dir(), { recursive: true })
    const tmp = file() + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(bundle, null, 2))
    await fs.rename(tmp, file())
  }

  // Read-modify-write helper. All mutations go through here so we hold a
  // cross-process Flock (via util/flock.ts) for the entire critical section,
  // preventing CLI ↔ daemon races.
  async function mutate<T>(fn: (bundle: Bundle) => T | Promise<T>): Promise<T> {
    return Flock.withLock(LOCK_KEY(), async () => {
      const bundle = await load()
      const result = await fn(bundle)
      await save(bundle)
      return result
    })
  }

  export async function list(): Promise<Job.Schema[]> {
    return (await load()).jobs
  }

  export async function get(id: string): Promise<Job.Schema | undefined> {
    const bundle = await load()
    return bundle.jobs.find((j) => j.id === id)
  }

  export async function create(input: Job.Input): Promise<Job.Schema> {
    return mutate((bundle) => {
      const job = Job.Schema.parse({
        ...input,
        id: ulid(),
        createdAt: Date.now(),
        failureCount: 0,
      })
      bundle.jobs.push(job)
      return job
    })
  }

  export async function update(id: string, patch: Partial<Job.Schema>): Promise<Job.Schema | undefined> {
    return mutate((bundle) => {
      const idx = bundle.jobs.findIndex((j) => j.id === id)
      if (idx < 0) return undefined
      const merged = Job.Schema.parse({ ...bundle.jobs[idx], ...patch })
      bundle.jobs[idx] = merged
      return merged
    })
  }

  export async function remove(id: string): Promise<boolean> {
    return mutate((bundle) => {
      const before = bundle.jobs.length
      bundle.jobs = bundle.jobs.filter((j) => j.id !== id)
      return bundle.jobs.length !== before
    })
  }

  export type RunRecord = {
    id: string
    jobId: string
    startedAt: number
    finishedAt: number
    status: "ok" | "skipped" | "fired" | "error"
    note?: string
    durationMs: number
  }

  export async function appendRun(record: RunRecord) {
    await fs.mkdir(runsDir(), { recursive: true })
    const target = path.join(runsDir(), `${record.jobId}.jsonl`)
    // fs.appendFile does a single write per call; on POSIX, writes ≤ PIPE_BUF
    // are atomic, so concurrent appends from different processes don't tear.
    await fs.appendFile(target, JSON.stringify(record) + "\n")
  }

  /**
   * Tail the last N records from a per-job run log.
   *
   * Optimisation: for large logs we seek from end and read at most ~1MB rather
   * than slurping the whole file. The first (potentially-partial) line in that
   * window is dropped so we never emit half-records. Malformed/truncated lines
   * are skipped rather than throwing — keeps `cron logs` usable even if a write
   * was interrupted.
   */
  export async function tailRuns(jobId: string, n = 50): Promise<RunRecord[]> {
    if (n <= 0) return []
    const target = path.join(runsDir(), `${jobId}.jsonl`)
    const handle = await fs.open(target, "r").catch(() => undefined)
    if (!handle) return []

    try {
      const stat = await handle.stat()
      if (stat.size === 0) return []

      const start = stat.size > TAIL_READ_CAP_BYTES ? stat.size - TAIL_READ_CAP_BYTES : 0
      const length = stat.size - start
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, start)
      const text = buf.toString("utf8")

      let lines = text.split("\n").filter(Boolean)
      // If we started mid-file, the first slice is likely a partial line.
      if (start > 0 && lines.length > 0) lines = lines.slice(1)

      const out: RunRecord[] = []
      for (const line of lines.slice(-n)) {
        try {
          out.push(JSON.parse(line) as RunRecord)
        } catch {
          // skip truncated/corrupt line
        }
      }
      return out
    } finally {
      await handle.close().catch(() => {})
    }
  }
}
