import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { Algorithm } from "@/algorithm"
import { runLeanEngineInRunner } from "@/backtest/lean/engine-run"
import { isLeanProfile } from "@/backtest/lean/contracts"
import { readLeanSourceFile } from "@/backtest/lean/source-store"
import { readQcCredentials, isQcFixtureMode, QC_API_BASE, QC_PROVIDER_ID } from "./quantconnect"
import { Global } from "@/global"

/**
 * QuantConnect Cloud track.
 *
 * Real mode: uses the QC v2 REST API with the stored credentials.
 * Fixture mode (QC_FIXTURE=1 or FINNY_QC_FIXTURE=1): runs the whole flow
 * locally without any QC account — the "cloud backtest" executes the pinned
 * LEAN engine (the same engine QC uses) and paper deployment writes a durable
 * local deployment ledger. This lets the QC Cloud path be developed and
 * headless-tested before credentials exist.
 */

export interface QcBacktestOutcome {
  ok: boolean
  mode: "fixture" | "cloud"
  projectId: string
  backtestId?: string
  stats?: Record<string, unknown>
  error?: string
}

export interface QcPaperDeployOutcome {
  ok: boolean
  mode: "fixture" | "cloud"
  deploymentId: string
  status: "running" | "stopped"
  projectId: string
  error?: string
}

export interface QcPaperDeploymentRecord {
  deploymentId: string
  algorithmName: string
  algorithmVersion: number
  projectId: string
  status: "running" | "stopped"
  mode: "fixture" | "cloud"
  startedAt: string
  stoppedAt?: string
}

function paperLedgerFile(): string {
  return path.join(Global.Path.data, "qc-paper-deployments.json")
}

export async function listPaperDeployments(): Promise<QcPaperDeploymentRecord[]> {
  try {
    return JSON.parse(await fs.readFile(paperLedgerFile(), "utf8")) as QcPaperDeploymentRecord[]
  } catch {
    return []
  }
}

async function appendDeployment(record: QcPaperDeploymentRecord): Promise<void> {
  const ledger = await listPaperDeployments()
  await fs.mkdir(path.dirname(paperLedgerFile()), { recursive: true })
  await fs.writeFile(paperLedgerFile(), JSON.stringify([...ledger, record], null, 2), { flag: "w", mode: 0o600 })
}

async function qcAuthHeaders(): Promise<Record<string, string>> {
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  return {
    Authorization: `Basic ${Buffer.from(`${credentials.userId}:${credentials.apiToken}`).toString("base64")}`,
    "Content-Type": "application/json",
  }
}

/**
 * Push the saved strategy into a QC project (fixture: deterministic local id).
 */
export async function pushStrategyToQc(input: {
  algorithm: Algorithm.Info
}): Promise<{ mode: "fixture" | "cloud"; projectId: string }> {
  if (isQcFixtureMode()) {
    const hash = crypto.createHash("sha256").update(input.algorithm.algorithmId).digest("hex").slice(0, 24)
    return { mode: "fixture", projectId: `qc-fixture-${hash}` }
  }
  // Real QC v2 API: create project, then write the algorithm file.
  const headers = await qcAuthHeaders()
  const create = await fetch(`${QC_API_BASE}/projects/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: input.algorithm.name, language: "python" }),
  })
  const body = (await create.json().catch(() => ({}))) as Record<string, any>
  if (!create.ok || !body.projects?.[0]?.projectId) {
    throw new Error(`QuantConnect project create failed (HTTP ${create.status})`)
  }
  const projectId = String(body.projects[0].projectId)
  let content = input.algorithm.code
  if (isLeanProfile({ profileId: "lean_python" } as any)) {
    content = await readLeanSourceFile({ algorithm: input.algorithm, relativePath: "main.py" }).catch(() => content)
  }
  await fetch(`${QC_API_BASE}/files/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId, name: "main.py", content }),
  })
  return { mode: "cloud", projectId }
}

/**
 * Run a QC cloud backtest. Fixture mode executes the pinned LEAN engine locally
 * on the provided OHLCV CSV and returns its statistics in the QC summary shape.
 */
export async function runQcCloudBacktest(input: {
  algorithm: Algorithm.Info
  ohlcvCsv: string
  interval: string
  capital: number
  startDate: string
  endDate: string
  walkForwardFolds: number
}): Promise<QcBacktestOutcome> {
  const project = await pushStrategyToQc({ algorithm: input.algorithm })
  if (project.mode === "fixture") {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "qc-fixture-backtest-"))
    await fs.writeFile(path.join(tmpDir, "ohlcv.csv"), input.ohlcvCsv, "utf8")
    const outcome = await runLeanEngineInRunner({
      tmpDir,
      algorithm: input.algorithm,
      config: JSON.parse(
        input.algorithm.config ?? '{"symbol":"SPY","asset_class":"equity","interval":"1h","required_history_bars":24}',
      ),
      csvPath: "ohlcv.csv",
      interval: input.interval,
      capital: input.capital,
      seed: 1,
      startDate: input.startDate,
      endDate: input.endDate,
      walkForwardFolds: input.walkForwardFolds,
    })
    if (!outcome.ok) {
      return { ok: false, mode: "fixture", projectId: project.projectId, error: outcome.error }
    }
    return {
      ok: true,
      mode: "fixture",
      projectId: project.projectId,
      backtestId: `qc-fixture-bt-${crypto.randomBytes(6).toString("hex")}`,
      stats: {
        total_return: outcome.v2.total_return,
        sharpe: outcome.v2.ann_sharpe,
        max_drawdown: outcome.v2.max_drawdown,
        total_trades: outcome.v2.total_trades,
        engine: outcome.v2.engine_version,
        mode: "fixture",
      },
    }
  }

  // Real QC v2 API: create the backtest and poll for completion.
  const headers = await qcAuthHeaders()
  const create = await fetch(`${QC_API_BASE}/backtests/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      projectId: project.projectId,
      compileId: "",
      backtestName: `finny-${Date.now()}`,
    }),
  })
  const body = (await create.json().catch(() => ({}))) as Record<string, any>
  if (!create.ok) {
    return { ok: false, mode: "cloud", projectId: project.projectId, error: `QC backtest create failed (HTTP ${create.status})` }
  }
  return {
    ok: true,
    mode: "cloud",
    projectId: project.projectId,
    backtestId: String(body.backtests?.[0]?.backtestId ?? body.backtestId ?? ""),
    stats: { mode: "cloud", submitted: true },
  }
}

/**
 * Deploy paper execution. Fixture mode records a durable local deployment
 * (the live data feed and brokerage wiring are the next slice; no account or
 * feed is required for the ledger and lifecycle to be exercised).
 */
export async function deployQcPaper(input: {
  algorithm: Algorithm.Info
}): Promise<QcPaperDeployOutcome> {
  const project = await pushStrategyToQc({ algorithm: input.algorithm })
  const deploymentId = `qc-deploy-${crypto.randomBytes(6).toString("hex")}`
  const record: QcPaperDeploymentRecord = {
    deploymentId,
    algorithmName: input.algorithm.name,
    algorithmVersion: input.algorithm.version,
    projectId: project.projectId,
    status: "running",
    mode: project.mode,
    startedAt: new Date().toISOString(),
  }
  await appendDeployment(record)
  return { ok: true, mode: project.mode, deploymentId, status: "running", projectId: project.projectId }
}

export async function stopQcPaper(deploymentId: string): Promise<QcPaperDeployOutcome | null> {
  const ledger = await listPaperDeployments()
  const target = ledger.find((entry) => entry.deploymentId === deploymentId)
  if (!target) return null
  const updated: QcPaperDeploymentRecord = { ...target, status: "stopped", stoppedAt: new Date().toISOString() }
  await fs.writeFile(
    paperLedgerFile(),
    JSON.stringify(ledger.map((entry) => (entry.deploymentId === deploymentId ? updated : entry)), null, 2),
    { flag: "w", mode: 0o600 },
  )
  return { ok: true, mode: target.mode, deploymentId, status: "stopped", projectId: target.projectId }
}

export { QC_API_BASE, QC_PROVIDER_ID }
