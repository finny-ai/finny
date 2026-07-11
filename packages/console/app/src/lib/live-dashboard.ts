import { query } from "@solidjs/router"

export type LiveDashboardRun = {
  algorithmName?: string
  symbol?: string
  interval?: string
  brokerage?: string
  mode?: string
  status: string
  startedAt?: number
  stoppedAt?: number
  lastEventAt: number
  hasError: boolean
}

export type LiveDashboardSnapshot = {
  generatedAt: number
  runningCount: number
  runningCountCapped: boolean
  recentRuns: LiveDashboardRun[]
}

export type LiveDashboardResult =
  | { state: "ready"; snapshot: LiveDashboardSnapshot }
  | { state: "unavailable"; reason: "not_configured" | "upstream_error" }

type RecordCheck = (input: Record<string, unknown>) => boolean

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function optionalNumber(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value))
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

const RUN_CHECKS: RecordCheck[] = [
  (input) => optionalString(input.algorithmName),
  (input) => optionalString(input.symbol),
  (input) => optionalString(input.interval),
  (input) => optionalString(input.brokerage),
  (input) => optionalString(input.mode),
  (input) => typeof input.status === "string",
  (input) => optionalNumber(input.startedAt),
  (input) => optionalNumber(input.stoppedAt),
  (input) => typeof input.lastEventAt === "number" && Number.isFinite(input.lastEventAt),
  (input) => typeof input.hasError === "boolean",
]

function isRun(value: unknown): value is LiveDashboardRun {
  const input = asRecord(value)
  return input !== undefined && RUN_CHECKS.every((check) => check(input))
}

const SNAPSHOT_CHECKS: RecordCheck[] = [
  (input) => input.ok === true,
  (input) => typeof input.generatedAt === "number" && Number.isFinite(input.generatedAt),
  (input) => typeof input.runningCount === "number" && Number.isFinite(input.runningCount),
  (input) => typeof input.runningCountCapped === "boolean",
  (input) => Array.isArray(input.recentRuns) && input.recentRuns.every(isRun),
]

function isSnapshot(value: unknown): value is LiveDashboardSnapshot & { ok: true } {
  const input = asRecord(value)
  return input !== undefined && SNAPSHOT_CHECKS.every((check) => check(input))
}

export const liveDashboard = query(async (): Promise<LiveDashboardResult> => {
  "use server"
  const url = process.env.FINNY_NATIVE_HEDGE_DASHBOARD_URL?.trim()
  const secret = process.env.FINNY_NATIVE_HEDGE_DASHBOARD_SECRET?.trim()
  if (!url || !secret) return { state: "unavailable", reason: "not_configured" }

  try {
    const response = await fetch(url, {
      headers: { "x-finny-dashboard-secret": secret },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return { state: "unavailable", reason: "upstream_error" }
    const body: unknown = await response.json()
    if (!isSnapshot(body)) return { state: "unavailable", reason: "upstream_error" }
    return { state: "ready", snapshot: body }
  } catch {
    return { state: "unavailable", reason: "upstream_error" }
  }
}, "live-dashboard")
