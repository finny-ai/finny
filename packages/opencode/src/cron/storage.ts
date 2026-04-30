import path from "path"
import fs from "fs/promises"
import { ulid } from "ulid"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Job } from "./job"

export namespace CronStorage {
  const dir = () => path.join(Global.Path.data, "cron")
  const file = () => path.join(dir(), "jobs.json")
  const runsDir = () => path.join(Global.Path.data, "cron", "runs")

  type Bundle = { version: 1; jobs: Job.Schema[] }

  async function load(): Promise<Bundle> {
    const raw = await Filesystem.readText(file()).catch(() => undefined)
    if (!raw) return { version: 1, jobs: [] }
    try {
      const parsed = JSON.parse(raw)
      const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : []
      return { version: 1, jobs: jobs.map((j: unknown) => Job.Schema.parse(j)) }
    } catch {
      return { version: 1, jobs: [] }
    }
  }

  async function save(bundle: Bundle) {
    await fs.mkdir(dir(), { recursive: true })
    const tmp = file() + ".tmp"
    await fs.writeFile(tmp, JSON.stringify(bundle, null, 2))
    await fs.rename(tmp, file())
  }

  export async function list(): Promise<Job.Schema[]> {
    return (await load()).jobs
  }

  export async function get(id: string): Promise<Job.Schema | undefined> {
    const bundle = await load()
    return bundle.jobs.find((j) => j.id === id)
  }

  export async function create(input: Omit<Job.Schema, "id" | "createdAt" | "failureCount">): Promise<Job.Schema> {
    const bundle = await load()
    const job: Job.Schema = Job.Schema.parse({
      ...input,
      id: ulid(),
      createdAt: Date.now(),
      failureCount: 0,
    })
    bundle.jobs.push(job)
    await save(bundle)
    return job
  }

  export async function update(id: string, patch: Partial<Job.Schema>): Promise<Job.Schema | undefined> {
    const bundle = await load()
    const idx = bundle.jobs.findIndex((j) => j.id === id)
    if (idx < 0) return undefined
    const merged = Job.Schema.parse({ ...bundle.jobs[idx], ...patch })
    bundle.jobs[idx] = merged
    await save(bundle)
    return merged
  }

  export async function remove(id: string): Promise<boolean> {
    const bundle = await load()
    const before = bundle.jobs.length
    bundle.jobs = bundle.jobs.filter((j) => j.id !== id)
    if (bundle.jobs.length === before) return false
    await save(bundle)
    return true
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
    await fs.appendFile(target, JSON.stringify(record) + "\n")
  }

  export async function tailRuns(jobId: string, n = 50): Promise<RunRecord[]> {
    const target = path.join(runsDir(), `${jobId}.jsonl`)
    const raw = await Filesystem.readText(target).catch(() => undefined)
    if (!raw) return []
    const lines = raw.trim().split("\n").filter(Boolean).slice(-n)
    return lines.map((l) => JSON.parse(l))
  }
}
