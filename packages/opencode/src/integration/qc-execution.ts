import path from "node:path"
import { GlobalBus } from "@/bus/global"
import type { Algorithm } from "@/algorithm"
import type { ControllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import { verifyPromotion, readJson, strictRunDir } from "@/backtest/run-integrity"
import type { LiveRunner } from "@/live/runner"
import {
  availableLiveNodes,
  compileQcProject,
  deployQcLive,
  pushLinkedSourceToQc,
} from "./qc-cloud"
import {
  getProjectLink,
  upsertDeployment,
  updateDeployment,
  getDeployment,
  listDeployments,
  appendDeploymentLog,
  listDeploymentLogs,
} from "./qc-store"
import { syncBeforeRun } from "./qc-sync"
import { qcProjectUrl } from "./qc-contracts"
import { readQcCredentials, isQcFixtureMode } from "./quantconnect"
import { qcLiveRead, qcLiveLogsRead, qcLivePortfolioRead, qcLiveOrdersRead, qcLiveStop, qcLiveLiquidate } from "./qc-client"
import crypto from "node:crypto"

/**
 * Durable QC execution manager.
 *
 * QC Paper deployments are daemon-owned records reconciled against the
 * QuantConnect Cloud API and surfaced through the existing live-run SSE
 * stream so the Portfolio page shows one continuous execution view.
 */

export interface QcRunDetail {
  projectId: number | string
  projectName?: string
  deploymentId: string
  liveUrl?: string
  ownership: "managed" | "external"
  qcStatus?: string
  lastSyncedAt?: number
  runIdentityHash?: string
  sourceTreeHash?: string
}

export type QcRunView = LiveRunner.Run & {
  backend: "qc"
  qc: QcRunDetail
}

interface QcRunState {
  run: QcRunView
  logCursor: number
  lastLogPollAt: number
  lastTelemetryPollAt: number
}

const states = new Map<string, QcRunState>()
const globalListeners = new Set<(runs: QcRunView[]) => void>()
let pollTimer: ReturnType<typeof setInterval> | undefined

export const QC_POLL_INTERVAL_MS = Number(process.env.FINNY_QC_POLL_INTERVAL_MS ?? 60_000)
export const QC_LOG_POLL_INTERVAL_MS = 5 * 60_000
export const QC_TELEMETRY_POLL_INTERVAL_MS = 10 * 60_000

function toRun(record: Awaited<ReturnType<typeof listDeployments>>[number]): QcRunView {
  return {
    id: `qc:${record.deploymentId}`,
    algorithmId: record.algorithmId,
    algorithmName: record.algorithmName,
    backtestRunId: record.runId ?? "",
    symbol: (record as any).symbol ?? "",
    interval: (record as any).interval ?? "",
    brokerKind: "qc",
    accountProviderID: `qc-paper:${record.projectId}`,
    accountLabel: record.projectName ?? `QuantConnect project ${record.projectId}`,
    mode: "paper",
    executionMode: "paper",
    status: record.status === "starting" ? "starting" : record.status === "running" ? "running" : record.status,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    error: record.error,
    equity: record.remoteEquity,
    cash: record.remoteCash,
    positions: {},
    orders: [],
    logs: [],
    shadowProof: {
      finalizedDecisionBars: 0,
      sessionIds: [],
      reconciliationDivergences: 0,
      fatalErrors: 0,
    },
    backend: "qc",
    qc: {
      projectId: record.projectId,
      projectName: record.projectName,
      deploymentId: record.deploymentId,
      liveUrl: record.liveUrl,
      ownership: record.ownership,
      qcStatus: record.qcStatus,
      lastSyncedAt: record.lastSyncedAt,
      runIdentityHash: record.runIdentityHash,
      sourceTreeHash: record.sourceTreeHash,
    },
  }
}

async function refreshState(record: Awaited<ReturnType<typeof listDeployments>>[number]) {
  const existing = states.get(record.deploymentId)
  const run = toRun(record)
  run.orders = existing?.run.orders ?? []
  run.logs = existing?.run.logs ?? (await listDeploymentLogs(record.deploymentId)).map((entry) => ({
    ts: entry.ts,
    level: entry.level,
    message: entry.message,
  }))
  states.set(record.deploymentId, {
    run,
    logCursor: existing?.logCursor ?? 0,
    lastLogPollAt: existing?.lastLogPollAt ?? 0,
    lastTelemetryPollAt: existing?.lastTelemetryPollAt ?? 0,
  })
}

export function list(): QcRunView[] {
  return [...states.values()].map((state) => state.run)
}

export function get(id: string): QcRunView | undefined {
  const key = id.startsWith("qc:") ? id.slice(3) : id
  return states.get(key)?.run
}

export function subscribeAll(listener: (runs: QcRunView[]) => void): () => void {
  globalListeners.add(listener)
  listener(list())
  return () => globalListeners.delete(listener)
}

function notify() {
  const runs = list()
  for (const listener of globalListeners) listener(runs)
  // QC deployments are account-level; publish to every known project
  // directory so the active TUI always sees them.
  const directories = new Set<string>(["global"])
  for (const run of runs) if (run.directory) directories.add(run.directory)
  for (const directory of directories) {
    GlobalBus.emit("event", {
      directory,
      payload: { type: "live.runs", properties: { runs } },
    })
  }
}

/** Rehydrate managed + discovered deployments into run views. */
export async function rehydrate(): Promise<QcRunView[]> {
  const records = await listDeployments()
  for (const record of records) await refreshState(record)
  notify()
  return list()
}

function parseDollar(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  const parsed = Number(String(value).replace(/[^0-9.\-]/g, ""))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** One reconciliation pass over all managed deployments. */
export async function reconcileManaged(): Promise<void> {
  const records = await listDeployments()
  for (const record of records) {
    if (record.ownership !== "managed") continue
    if (record.status !== "running" && record.status !== "starting") continue
    const state = states.get(record.deploymentId)
    if ((await isQcFixtureMode())) {
      // Fixture deployments stay "running" until explicitly stopped.
      await updateDeployment(record.deploymentId, { qcStatus: "Running", lastSyncedAt: Date.now() })
      await refreshState({ ...record, qcStatus: "Running", lastSyncedAt: Date.now() })
      continue
    }
    const credentials = await readQcCredentials().catch(() => null)
    if (!credentials) continue
    try {
      const current = await qcLiveRead(credentials, {
        projectId: record.projectId,
        deployId: record.deploymentId,
      })
      if (!current) continue
      const terminal =
        current.status === "Stopped" ||
        current.status === "Liquidated" ||
        current.status === "Deleted" ||
        current.status === "RuntimeError" ||
        current.status === "DeployError" ||
        current.status === "Invalid"
      const remoteEquity = parseDollar(current.runtimeStatistics?.Equity)
      const patch: Record<string, unknown> = {
        qcStatus: current.status,
        lastSyncedAt: Date.now(),
        ...(remoteEquity !== undefined ? { remoteEquity } : {}),
        ...(current.runtimeStatistics ? { remoteRuntimeStatistics: current.runtimeStatistics } : {}),
      }
      if (terminal) {
        Object.assign(patch, {
          status: current.status === "RuntimeError" || current.status === "DeployError" || current.status === "Invalid"
            ? ("error" as const)
            : ("stopped" as const),
          stoppedAt: Date.now(),
          error: current.message,
        })
        await appendDeploymentLog(record.deploymentId, {
          level: current.status === "RuntimeError" || current.status === "DeployError" ? "error" : "info",
          message: `QC deployment entered terminal status ${current.status}${current.message ? `: ${current.message}` : ""}`,
        })
      } else {
        const now = Date.now()
        if (now - (state?.lastLogPollAt ?? 0) >= QC_LOG_POLL_INTERVAL_MS) {
          try {
            const logs = await qcLiveLogsRead(credentials, {
              projectId: record.projectId,
              algorithmId: record.deploymentId,
              startLine: state?.logCursor ?? 0,
              endLine: (state?.logCursor ?? 0) + 250,
            })
            if (logs.logs.length > 0) {
              for (const line of logs.logs) {
                await appendDeploymentLog(record.deploymentId, { level: "info", message: line })
              }
              patch.logCursor = (state?.logCursor ?? 0) + logs.logs.length
              patch.lastLogPollAt = now
            }
          } catch {}
        }
        if (now - (state?.lastTelemetryPollAt ?? 0) >= QC_TELEMETRY_POLL_INTERVAL_MS) {
          try {
            const [portfolio, orders] = await Promise.all([
              qcLivePortfolioRead(credentials, { projectId: record.projectId }),
              qcLiveOrdersRead(credentials, {
                projectId: record.projectId,
                algorithmId: record.deploymentId,
                start: 0,
                end: 100,
              }),
            ])
            const cash = portfolio.cash.reduce((sum, item) => sum + item.valueInAccountCurrency, 0)
            const holdingsValue = Object.values(portfolio.holdings).reduce((sum, item) => sum + item.v, 0)
            Object.assign(patch, {
              remoteCash: cash,
              remoteEquity: remoteEquity ?? cash + holdingsValue,
              remoteHoldings: portfolio.holdings,
              remoteOrders: orders,
              lastTelemetryPollAt: now,
            })
          } catch {}
        }
      }
      const updated = await updateDeployment(record.deploymentId, patch as never)
      if (updated) await refreshState(updated)
    } catch {
      // Transient API error — keep the run visible and stale rather than
      // dropping it. The TUI surfaces lastSyncedAt to make staleness visible.
    }
  }
}

export function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void reconcileManaged().catch(() => undefined)
  }, QC_POLL_INTERVAL_MS)
  pollTimer.unref?.()
}

export function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

export async function ensureRunning(): Promise<void> {
  await rehydrate()
  startPolling()
}

export interface QcDeployResult {
  ok: boolean
  deploymentId?: string
  status?: "starting" | "running" | "stopped" | "error"
  projectId?: number | string
  error?: string
  idempotent?: boolean
}

/**
 * Approve-and-deploy: starts the exact approved run on QC Paper. Idempotent
 * by (run identity hash, project, environment) so retries cannot create
 * duplicate paper algorithms.
 */
export async function startPaperDeployment(input: {
  algorithm: Algorithm.Info
  runId: string
  authority?: ControllerPaperApproval
  nodeId?: string
  capital?: number
}): Promise<QcDeployResult> {
  const promotion = await verifyPromotion({
    algorithm: input.algorithm,
    runId: input.runId,
    mode: "paper",
    controllerApproval: input.authority,
  })
  if (!promotion.ok || !promotion.run) {
    return { ok: false, error: `Paper approval is not valid for run ${input.runId}: ${promotion.errors.join("; ")}` }
  }
  const promotionRun = promotion.run
  const link = await getProjectLink(input.algorithm.algorithmId)
  if (!link) {
    return { ok: false, error: "algorithm is not linked to a QuantConnect project" }
  }
  const sync = await syncBeforeRun(input.algorithm)
  if (!sync.ok) {
    return {
      ok: false,
      error: `QuantConnect project ${link.projectId} is not synchronized (${sync.action ?? "blocked"}): ${(sync.drift ?? []).join("; ")}`,
    }
  }
  const existing = (await listDeployments()).find(
    (record) =>
      record.ownership === "managed" &&
      record.projectId === link.projectId &&
      record.environment === "qc_paper" &&
      record.runIdentityHash === promotionRun.identityHash,
  )
  if (existing) {
    await refreshState(existing)
    notify()
    return {
      ok: existing.status !== "error",
      deploymentId: existing.deploymentId,
      status: existing.status,
      projectId: existing.projectId,
      idempotent: true,
      ...(existing.error ? { error: existing.error } : {}),
    }
  }
  const active = (await listDeployments()).find(
    (record) =>
      record.ownership === "managed" &&
      record.projectId === link.projectId &&
      (record.status === "running" || record.status === "starting"),
  )
  if (active) {
    return {
      ok: false,
      error: `QuantConnect project ${link.projectId} already has an active deployment (${active.deploymentId}). Stop it before deploying another run.`,
    }
  }

  let config: Record<string, any> = {}
  try {
    config = await readJson<Record<string, any>>({
      file: path.join(strictRunDir(input.algorithm, input.runId), "effective_config.json"),
    })
  } catch {
    config = {}
  }
  const symbol = typeof config.symbol === "string" ? config.symbol : ""
  const interval = typeof config.interval === "string" ? config.interval : ""
  const capital =
    input.capital ??
    (typeof config.equity_usd === "number" ? config.equity_usd : typeof config.risk?.starting_equity_usd === "number" ? config.risk.starting_equity_usd : 10000)

  const deploymentId = `qc-deploy-${crypto.randomBytes(6).toString("hex")}`
  const record = {
    schema: "finny.qc_deployment" as const,
    version: 1 as const,
    deploymentId,
    algorithmId: input.algorithm.algorithmId,
    algorithmName: input.algorithm.name,
    algorithmVersion: input.algorithm.version,
    runId: input.runId,
    runIdentityHash: promotionRun.identityHash,
    sourceTreeHash: link.sync.lastLocalTreeHash,
    projectId: link.projectId,
    projectName: link.projectName,
    environment: "qc_paper" as const,
    brokerKind: "qc_paper" as const,
    nodeId: input.nodeId,
    capital,
    status: "starting" as const,
    ownership: "managed" as const,
    qcStatus: "InQueue",
    liveUrl: qcProjectUrl(link.projectId),
    startedAt: Date.now(),
    mode: (await isQcFixtureMode()) ? ("fixture" as const) : ("cloud" as const),
    symbol,
    interval,
  }
  await upsertDeployment(record as never)
  await appendDeploymentLog(deploymentId, {
    level: "info",
    message: `Approved run ${input.runId} → QC Paper project ${link.projectId}`,
  })
  await refreshState(record as never)
  notify()

  if ((await isQcFixtureMode())) {
    const running = await updateDeployment(deploymentId, { status: "running", qcStatus: "Running" })
    if (running) await refreshState(running)
    notify()
    return { ok: true, deploymentId, status: "running", projectId: link.projectId }
  }

  try {
    const pushed = await pushLinkedSourceToQc({ algorithm: input.algorithm })
    const compile = await compileQcProject({ projectId: pushed.projectId })
    if (compile.state !== "BuildSuccess") {
      const failed = await updateDeployment(deploymentId, {
        status: "error",
        error: `QuantConnect compile failed (${compile.state})`,
      })
      if (failed) await refreshState(failed)
      notify()
      return {
        ok: false,
        deploymentId,
        status: "error",
        projectId: link.projectId,
        error: `QuantConnect compile failed (${compile.state})`,
      }
    }
    const nodes = await availableLiveNodes(pushed.projectId)
    const node = input.nodeId ?? nodes.find((candidate) => !candidate.busy)?.id ?? nodes[0]?.id
    if (!node) {
      const failed = await updateDeployment(deploymentId, {
        status: "error",
        error: "No live node available for this project; add one in QuantConnect first",
      })
      if (failed) await refreshState(failed)
      notify()
      return { ok: false, deploymentId, status: "error", projectId: link.projectId, error: "No live node available for this project; add one in QuantConnect first" }
    }
    const outcome = await deployQcLive({
      algorithm: input.algorithm,
      projectId: pushed.projectId,
      compileId: compile.compileId,
      nodeId: node,
      brokerKind: "qc_paper",
      capital,
    })
    if (!outcome.ok || !outcome.deploymentId) {
      const failed = await updateDeployment(deploymentId, {
        status: "error",
        error: outcome.error ?? "QuantConnect live deployment failed",
        qcStatus: outcome.status,
      })
      if (failed) await refreshState(failed)
      notify()
      return {
        ok: false,
        deploymentId,
        status: "error",
        projectId: link.projectId,
        error: outcome.error ?? "QuantConnect live deployment failed",
      }
    }
    const running = await updateDeployment(deploymentId, {
      status: "running",
      qcStatus: "Running",
      compileId: compile.compileId,
      nodeId: node,
      liveUrl: qcProjectUrl(link.projectId),
    })
    if (running) await refreshState(running)
    notify()
    return { ok: true, deploymentId, status: "running", projectId: link.projectId }
  } catch (error) {
    const failed = await updateDeployment(deploymentId, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    })
    if (failed) await refreshState(failed)
    notify()
    return { ok: false, deploymentId, status: "error", projectId: link.projectId, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function stopDeployment(deploymentId: string): Promise<QcDeployResult> {
  const record = await getDeployment(deploymentId)
  if (!record) return { ok: false, error: `Deployment ${deploymentId} not found` }
  if ((await isQcFixtureMode())) {
    const updated = await updateDeployment(deploymentId, { status: "stopped", stoppedAt: Date.now(), qcStatus: "Stopped" })
    if (updated) await refreshState(updated)
    notify()
    return { ok: true, deploymentId, status: "stopped", projectId: record.projectId }
  }
  const credentials = await readQcCredentials()
  if (!credentials) return { ok: false, error: "QuantConnect credentials are not connected" }
  await qcLiveStop(credentials, { projectId: record.projectId, deployId: deploymentId })
  const updated = await updateDeployment(deploymentId, { status: "stopped", stoppedAt: Date.now(), qcStatus: "Stopped" })
  if (updated) await refreshState(updated)
  notify()
  return { ok: true, deploymentId, status: "stopped", projectId: record.projectId }
}

export async function liquidateDeployment(deploymentId: string): Promise<QcDeployResult> {
  const record = await getDeployment(deploymentId)
  if (!record) return { ok: false, error: `Deployment ${deploymentId} not found` }
  if ((await isQcFixtureMode())) {
    const updated = await updateDeployment(deploymentId, { status: "stopped", stoppedAt: Date.now(), qcStatus: "Liquidated" })
    if (updated) await refreshState(updated)
    notify()
    return { ok: true, deploymentId, status: "stopped", projectId: record.projectId }
  }
  const credentials = await readQcCredentials()
  if (!credentials) return { ok: false, error: "QuantConnect credentials are not connected" }
  await qcLiveLiquidate(credentials, { projectId: record.projectId, deployId: deploymentId })
  const updated = await updateDeployment(deploymentId, { status: "stopped", stoppedAt: Date.now(), qcStatus: "Liquidated" })
  if (updated) await refreshState(updated)
  notify()
  return { ok: true, deploymentId, status: "stopped", projectId: record.projectId }
}

/** Discover QC deployments that predate Finny management (read-only). */
export async function discoverExternalDeployments(): Promise<void> {
  if ((await isQcFixtureMode())) return
  const credentials = await readQcCredentials().catch(() => null)
  if (!credentials) return
  try {
    const { qcLiveList } = await import("./qc-client")
    const deployments = await qcLiveList(credentials, {})
    const known = await listDeployments()
    for (const deployment of deployments) {
      if (known.some((record) => record.deploymentId === deployment.deployId)) continue
      const record = {
        schema: "finny.qc_deployment" as const,
        version: 1 as const,
        deploymentId: deployment.deployId,
        algorithmId: `external-${deployment.deployId}`,
        algorithmName: `QC deployment ${deployment.deployId}`,
        algorithmVersion: 1,
        projectId: deployment.projectId,
        environment: "qc_paper" as const,
        brokerKind: "qc_paper" as const,
        capital: 0,
        status: (deployment.status === "Running" ? "running" : deployment.status === "InQueue" ? "starting" : "stopped") as "running" | "starting" | "stopped",
        ownership: "external" as const,
        qcStatus: deployment.status,
        liveUrl: qcProjectUrl(deployment.projectId),
        startedAt: deployment.launched ? Date.parse(deployment.launched) || Date.now() : Date.now(),
        stoppedAt: deployment.stopped ? Date.parse(deployment.stopped) || undefined : undefined,
        mode: "cloud" as const,
      }
      await upsertDeployment(record)
      await refreshState(record)
    }
    notify()
  } catch {}
}
