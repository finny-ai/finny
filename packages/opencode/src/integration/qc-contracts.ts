import crypto from "node:crypto"
import { stableHash } from "@/backtest/lean/contracts"

/**
 * Durable contracts for the QC-Native control plane (PR #105).
 *
 * A linked QuantConnect project is bound to exactly one Finny algorithm.
 * Every Finny algorithm version keeps an immutable source snapshot so the
 * QC Cloud and local Crucible/LEAN evaluations can be bound to the same
 * exact bytes without silently overwriting either side.
 */

export type QcProjectLanguage = "python" | "csharp"

export type QcSyncState = "in_sync" | "qc_changed" | "finny_changed" | "both_changed"

/**
 * QC track mode.
 *
 * `fixture` runs the whole QC control plane against deterministic local
 * fixtures (no credentials, no QC Cloud calls) — ideal for development and
 * testing the UI. `cloud` talks to the client's real QuantConnect account.
 * The mode is a durable user setting; environment variables remain a
 * test-only override.
 */
export type QcMode = "fixture" | "cloud"

export type QcModeSource = "env" | "setting" | "default"

export interface QcModeResolution {
  mode: QcMode
  configured: QcMode
  source: QcModeSource
}

export interface QcSourceFile {
  path: string
  sha256: string
  bytes: number
}

export interface QcSourceSnapshotV1 {
  schema: "finny.qc_source_snapshot"
  version: 1
  algorithmId: string
  algorithmVersion: number
  profileId: "qc_cloud"
  files: QcSourceFile[]
  sourceTreeHash: string
}

export interface QcProjectLinkV1 {
  schema: "finny.qc_project_link"
  version: 1
  algorithmId: string
  algorithmVersion: number
  projectId: number
  projectName: string
  organizationId: string
  language: QcProjectLanguage
  leanVersionId: number
  sync: {
    state: QcSyncState
    lastSyncedAt: number
    lastRemoteTreeHash: string
    lastLocalTreeHash: string
    driftDetail: string[]
  }
  linkedAt: number
  time_updated: number
}

export interface QcLocalEvidenceRef {
  runId: string
  identityHash: string
  runtimeHash: string
  engine: "lean_python" | "lean_csharp"
}

export interface QcCloudEvidenceRef {
  projectId: number
  compileId: string
  backtestId: string
  leanVersionId: number
  sourceTreeHash: string
  parameters: Record<string, string | number>
  statistics: Record<string, unknown>
  backtestUrl: string
}

export interface QcCompositeRunIdentityV1 {
  schema: "finny.qc_composite_run_identity"
  version: 1
  algorithmId: string
  algorithmVersion: number
  runId: string
  local: QcLocalEvidenceRef
  cloud: QcCloudEvidenceRef
  compositeHash: string
}

export interface QcExecutionTargetV1 {
  schema: "finny.qc_execution_target"
  version: 1
  algorithmId: string
  algorithmVersion: number
  runId: string
  runIdentityHash: string
  sourceTreeHash: string
  projectId: number
  projectName: string
  environment: "qc_paper"
  brokerKind: "qc_paper"
  capital: number
  nodeId?: string
  targetHash: string
}

export interface QcDeploymentRecordV1 {
  schema: "finny.qc_deployment"
  version: 1
  deploymentId: string
  algorithmId: string
  algorithmName: string
  algorithmVersion: number
  runId?: string
  runIdentityHash?: string
  sourceTreeHash?: string
  projectId: number | string
  projectName?: string
  environment: "qc_paper"
  brokerKind: "qc_paper"
  nodeId?: string
  compileId?: string
  capital: number
  status: "starting" | "running" | "stopped" | "error"
  ownership: "managed" | "external"
  qcStatus?: string
  liveUrl?: string
  startedAt: number
  stoppedAt?: number
  lastSyncedAt?: number
  error?: string
  remoteEquity?: number
  remoteCash?: number
  remoteHoldings?: Record<string, unknown>
  remoteOrders?: unknown[]
  remoteRuntimeStatistics?: Record<string, unknown>
  mode?: "fixture" | "cloud"
  symbol?: string
  interval?: string
  logCursor?: number
  lastLogPollAt?: number
  lastTelemetryPollAt?: number
}

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function isSafeQcPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

export function sourceTreeHashForFiles(files: QcSourceFile[]): string {
  const canonical = files
    .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return stableHash(canonical)
}

export function buildQcSourceSnapshot(input: {
  algorithmId: string
  algorithmVersion: number
  files: QcSourceFile[]
}): QcSourceSnapshotV1 {
  const unsafe = input.files.find((file) => !isSafeQcPath(file.path))
  if (unsafe) throw new Error(`unsafe QC source path: ${unsafe.path}`)
  const canonical = input.files
    .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    schema: "finny.qc_source_snapshot",
    version: 1,
    algorithmId: input.algorithmId,
    algorithmVersion: input.algorithmVersion,
    profileId: "qc_cloud",
    files: canonical,
    sourceTreeHash: sourceTreeHashForFiles(canonical),
  }
}

export function compareSourceTrees(local: QcSourceFile[], remote: QcSourceFile[]): {
  same: boolean
  changed: string[]
  added: string[]
  removed: string[]
} {
  const localByPath = new Map(local.map((file) => [file.path, file]))
  const remoteByPath = new Map(remote.map((file) => [file.path, file]))
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const [path, remoteFile] of remoteByPath) {
    const localFile = localByPath.get(path)
    if (!localFile) {
      added.push(path)
    } else if (localFile.sha256 !== remoteFile.sha256 || localFile.bytes !== remoteFile.bytes) {
      changed.push(path)
    }
  }
  for (const path of localByPath.keys()) {
    if (!remoteByPath.has(path)) removed.push(path)
  }
  return { same: added.length === 0 && removed.length === 0 && changed.length === 0, changed, added, removed }
}

export function qcDriftState(input: {
  local: QcSourceFile[]
  remote: QcSourceFile[]
  lastSyncedLocalHash?: string
  lastSyncedRemoteHash?: string
}): { state: QcSyncState; detail: string[] } {
  const remoteChanged = !input.lastSyncedRemoteHash || input.lastSyncedRemoteHash !== sourceTreeHashForFiles(input.remote)
  const localChanged = !input.lastSyncedLocalHash || input.lastSyncedLocalHash !== sourceTreeHashForFiles(input.local)
  if (!remoteChanged && !localChanged) return { state: "in_sync", detail: [] }
  const detail: string[] = []
  if (remoteChanged) detail.push("QuantConnect project source changed after the last Finny sync")
  if (localChanged) detail.push("Finny algorithm version changed after the last sync")
  if (remoteChanged && localChanged) return { state: "both_changed", detail }
  return { state: remoteChanged ? "qc_changed" : "finny_changed", detail }
}

export function qcLanguageFromProject(projectLanguage: string | undefined): QcProjectLanguage {
  const raw = (projectLanguage ?? "").trim().toLowerCase()
  if (raw === "c#" || raw === "csharp" || raw === "cs") return "csharp"
  return "python"
}

/** Canonicalize a QC statistic string into a Finny numeric unit. */
function canonicalNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^0-9.\-+]/g, "")
    .trim()
  if (!cleaned) return undefined
  const parsed = Number(cleaned)
  if (!Number.isFinite(parsed)) return undefined
  const isPercent = String(value).includes("%")
  return isPercent ? parsed / 100 : parsed
}

export interface QcCanonicalStatistics {
  total_return?: number
  sharpe?: number
  sortino?: number
  max_drawdown?: number
  total_trades?: number
  net_profit?: number
  fees?: number
  equity?: number
  alpha?: number
  beta?: number
  annual_vol?: number
  win_rate?: number
  profit_factor?: number
  start_equity?: number
  end_equity?: number
  raw: Record<string, string | number>
}

/**
 * QC returns human strings like "12.34%", "-$3.40", "$100.00". Convert them
 * to Finny's numeric units (fractions for returns/drawdowns, absolute for
 * currency) without trusting the headline strings directly.
 */
export function canonicalizeQcStatistics(statistics: Record<string, string | number> | undefined): QcCanonicalStatistics {
  const raw = statistics ?? {}
  const get = (key: string): string | number | undefined =>
    raw[key] ?? raw[key.toLowerCase()] ?? raw[key.replace(/\s/g, "")]
  const num = (key: string): number | undefined => canonicalNumber(get(key))
  const negate = (value: number | undefined): number | undefined => (value === undefined ? undefined : -Math.abs(value))
  return {
    total_return: num("Total Return") ?? num("Return"),
    sharpe: num("Sharpe Ratio"),
    sortino: num("Sortino Ratio"),
    max_drawdown: negate(num("Drawdown")),
    total_trades: num("Total Trades") ?? num("Total Orders"),
    net_profit: num("Net Profit"),
    fees: num("Fees"),
    equity: num("Equity"),
    alpha: num("Alpha"),
    beta: num("Beta"),
    annual_vol: num("Annual Standard Deviation"),
    win_rate: num("Win Rate"),
    profit_factor: num("Profit-Loss Ratio"),
    start_equity: num("Start Equity"),
    end_equity: num("End Equity"),
    raw,
  }
}

export function buildQcExecutionTarget(input: {
  algorithmId: string
  algorithmVersion: number
  runId: string
  runIdentityHash: string
  sourceTreeHash: string
  projectId: number
  projectName: string
  capital: number
  nodeId?: string
}): QcExecutionTargetV1 {
  const target: QcExecutionTargetV1 = {
    schema: "finny.qc_execution_target",
    version: 1,
    algorithmId: input.algorithmId,
    algorithmVersion: input.algorithmVersion,
    runId: input.runId,
    runIdentityHash: input.runIdentityHash,
    sourceTreeHash: input.sourceTreeHash,
    projectId: input.projectId,
    projectName: input.projectName,
    environment: "qc_paper",
    brokerKind: "qc_paper",
    capital: input.capital,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    targetHash: "",
  }
  const { targetHash: _omit, ...rest } = target
  return { ...target, targetHash: stableHash(rest) }
}

export function buildQcCompositeRunIdentity(input: {
  algorithmId: string
  algorithmVersion: number
  runId: string
  local: QcLocalEvidenceRef
  cloud: QcCloudEvidenceRef
}): QcCompositeRunIdentityV1 {
  const identity: QcCompositeRunIdentityV1 = {
    schema: "finny.qc_composite_run_identity",
    version: 1,
    algorithmId: input.algorithmId,
    algorithmVersion: input.algorithmVersion,
    runId: input.runId,
    local: input.local,
    cloud: input.cloud,
    compositeHash: "",
  }
  const { compositeHash: _omit, ...rest } = identity
  return { ...identity, compositeHash: stableHash(rest) }
}

export function qcProjectUrl(projectId: number | string): string {
  return `https://www.quantconnect.com/project/${projectId}`
}

export function qcBacktestUrl(projectId: number | string, backtestId: string): string {
  return `https://www.quantconnect.com/project/${projectId}/backtest/${backtestId}`
}
