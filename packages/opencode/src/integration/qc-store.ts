import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { Global } from "@/global"
import type {
  QcDeploymentRecordV1,
  QcProjectLinkV1,
  QcSourceSnapshotV1,
  QcMode,
} from "./qc-contracts"

/**
 * Durable store for the QC-Native control plane.
 *
 * State lives under the Finny data root in three files plus two directories:
 *   qc-project-links.json   — one link per Finny algorithm
 *   qc-deployments.json     — managed + discovered QC deployments
 *   snapshots/<algorithmId>/v<NN>.json — immutable per-version source snapshots
 *   deployment-logs/<deploymentId>.jsonl — append-only log/event ledger
 *
 * The legacy `qc-paper-deployments.json` ledger is imported once on first load
 * so existing fixture/cloud deployments survive the migration.
 */

function controlRoot(): string {
  const override = process.env.FINNY_QC_CONTROL_DIR
  return override ?? path.join(Global.Path.data, "qc-control")
}

function linksFile(): string {
  return process.env.FINNY_QC_LINKS_FILE ?? path.join(controlRoot(), "qc-project-links.json")
}

function deploymentsFile(): string {
  return process.env.FINNY_QC_DEPLOYMENTS_FILE ?? path.join(controlRoot(), "qc-deployments.json")
}

function legacyDeploymentsFile(): string {
  return process.env.FINNY_QC_LEGACY_FILE ?? path.join(Global.Path.data, "qc-paper-deployments.json")
}

function qcModeFile(): string {
  return path.join(controlRoot(), "qc-mode.json")
}

function snapshotFile(algorithmId: string, version: number): string {
  // Never funnel non-conforming ids into one shared directory: two algorithms
  // would silently overwrite each other's immutable snapshots.
  const safe = /^[0-9a-fA-F-]{8,64}$/.test(algorithmId)
    ? algorithmId
    : crypto.createHash("sha256").update(algorithmId).digest("hex").slice(0, 40)
  return path.join(controlRoot(), "snapshots", safe, `v${String(version).padStart(2, "0")}.json`)
}

function deploymentLogFile(deploymentId: string): string {
  const safe = deploymentId.replace(/[^A-Za-z0-9._-]/g, "_")
  return path.join(controlRoot(), "deployment-logs", `${safe}.jsonl`)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
}

// ------------------------------------------------------------------ mode ----

/**
 * Durable QC track mode (local fixture vs QuantConnect Cloud). Defaults to
 * `cloud`; environment variables are handled by the caller as a test-only
 * override and never written here.
 */
/** Persisted mode, or null when the user has never chosen one. */
export async function readQcModeSetting(): Promise<QcMode | null> {
  const value = await readJson<{ mode?: unknown }>(qcModeFile())
  return value?.mode === "fixture" || value?.mode === "cloud" ? value.mode : null
}

export async function getConfiguredQcMode(): Promise<QcMode> {
  return (await readQcModeSetting()) ?? "cloud"
}

export async function setConfiguredQcMode(mode: QcMode): Promise<QcMode> {
  await writeJsonAtomic(qcModeFile(), { schema: "finny.qc_mode", version: 1, mode, updatedAt: Date.now() })
  return mode
}

// ---------------------------------------------------------------- links ----

export async function listProjectLinks(): Promise<QcProjectLinkV1[]> {
  return (await readJson<QcProjectLinkV1[]>(linksFile())) ?? []
}

export async function getProjectLink(algorithmId: string): Promise<QcProjectLinkV1 | null> {
  const links = await listProjectLinks()
  return links.find((link) => link.algorithmId === algorithmId) ?? null
}

export async function upsertProjectLink(link: QcProjectLinkV1): Promise<QcProjectLinkV1> {
  const links = await listProjectLinks()
  const next = [...links.filter((item) => item.algorithmId !== link.algorithmId), link]
  await writeJsonAtomic(linksFile(), next)
  return link
}

export async function removeProjectLink(algorithmId: string): Promise<boolean> {
  const links = await listProjectLinks()
  const next = links.filter((item) => item.algorithmId !== algorithmId)
  if (next.length === links.length) return false
  await writeJsonAtomic(linksFile(), next)
  return true
}

export async function updateProjectLinkSync(
  algorithmId: string,
  patch: Partial<QcProjectLinkV1["sync"]>,
): Promise<QcProjectLinkV1 | null> {
  const link = await getProjectLink(algorithmId)
  if (!link) return null
  const updated: QcProjectLinkV1 = {
    ...link,
    sync: { ...link.sync, ...patch },
    time_updated: Date.now(),
  }
  await upsertProjectLink(updated)
  return updated
}

// ------------------------------------------------------------ snapshots ----

export async function saveSourceSnapshot(snapshot: QcSourceSnapshotV1): Promise<void> {
  await writeJsonAtomic(snapshotFile(snapshot.algorithmId, snapshot.algorithmVersion), snapshot)
}

export async function loadSourceSnapshot(
  algorithmId: string,
  version: number,
): Promise<QcSourceSnapshotV1 | null> {
  const snapshot = await readJson<QcSourceSnapshotV1>(snapshotFile(algorithmId, version))
  if (!snapshot || snapshot.schema !== "finny.qc_source_snapshot" || snapshot.version !== 1) return null
  return snapshot
}

// ---------------------------------------------------------- deployments ----

export interface QcDeploymentLogEntry {
  ts: number
  level: "info" | "warn" | "error"
  message: string
  remote?: unknown
}

export async function listDeployments(): Promise<QcDeploymentRecordV1[]> {
  const records = (await readJson<QcDeploymentRecordV1[]>(deploymentsFile())) ?? []
  if (records.length > 0) return records
  // One-time legacy import of the pre-#105 `qc-paper-deployments.json` ledger.
  const legacy = await readJson<LegacyQcDeployment[]>(legacyDeploymentsFile())
  if (!legacy || legacy.length === 0) return []
  const imported = legacy.map(legacyToDeployment).filter((item): item is QcDeploymentRecordV1 => item !== null)
  if (imported.length > 0) await writeJsonAtomic(deploymentsFile(), imported)
  return imported
}

interface LegacyQcDeployment {
  deploymentId: string
  algorithmName?: string
  algorithmVersion?: number
  algorithmId?: string
  projectId?: number | string
  status?: "running" | "stopped"
  mode?: "fixture" | "cloud"
  startedAt?: string
  stoppedAt?: string
  compileId?: string
  brokerKind?: string
  liveUrl?: string
  error?: string
}

function legacyToDeployment(entry: LegacyQcDeployment): QcDeploymentRecordV1 | null {
  if (!entry.deploymentId) return null
  return {
    schema: "finny.qc_deployment",
    version: 1,
    deploymentId: entry.deploymentId,
    algorithmId: entry.algorithmId ?? `legacy-${entry.deploymentId}`,
    algorithmName: entry.algorithmName ?? "legacy-qc-deployment",
    algorithmVersion: entry.algorithmVersion ?? 1,
    projectId: entry.projectId ?? 0,
    environment: "qc_paper",
    brokerKind: "qc_paper",
    compileId: entry.compileId,
    capital: 10000,
    status: entry.status === "running" ? "running" : "stopped",
    ownership: "managed",
    qcStatus: entry.status,
    liveUrl: entry.liveUrl,
    startedAt: entry.startedAt ? Date.parse(entry.startedAt) || Date.now() : Date.now(),
    stoppedAt: entry.stoppedAt ? Date.parse(entry.stoppedAt) || undefined : undefined,
    error: entry.error,
    mode: entry.mode,
  }
}

export async function getDeployment(deploymentId: string): Promise<QcDeploymentRecordV1 | null> {
  const records = await listDeployments()
  return records.find((record) => record.deploymentId === deploymentId) ?? null
}

export async function upsertDeployment(record: QcDeploymentRecordV1): Promise<void> {
  const records = await listDeployments()
  const next = [...records.filter((item) => item.deploymentId !== record.deploymentId), record]
  await writeJsonAtomic(deploymentsFile(), next)
}

export async function updateDeployment(
  deploymentId: string,
  patch: Partial<QcDeploymentRecordV1>,
): Promise<QcDeploymentRecordV1 | null> {
  const record = await getDeployment(deploymentId)
  if (!record) return null
  // lastSyncedAt means "last reconciled with QuantConnect"; only the
  // reconciliation loop (or an explicit caller) stamps it. Status changes
  // must not masquerade as fresh remote snapshots.
  const updated = {
    ...record,
    ...patch,
    ...(patch.lastSyncedAt === undefined ? {} : { lastSyncedAt: patch.lastSyncedAt }),
  }
  await upsertDeployment(updated)
  return updated
}

export async function appendDeploymentLog(
  deploymentId: string,
  entry: Omit<QcDeploymentLogEntry, "ts">,
): Promise<void> {
  const file = deploymentLogFile(deploymentId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify({ ...entry, ts: Date.now() })}\n`, { mode: 0o600 })
}

export async function listDeploymentLogs(deploymentId: string): Promise<QcDeploymentLogEntry[]> {
  try {
    const lines = (await fs.readFile(deploymentLogFile(deploymentId), "utf8")).split("\n").filter(Boolean)
    return lines.map((line) => JSON.parse(line) as QcDeploymentLogEntry)
  } catch {
    return []
  }
}
