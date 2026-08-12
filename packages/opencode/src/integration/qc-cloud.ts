import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { Algorithm } from "@/algorithm"
import { runLeanEngineInRunner } from "@/backtest/lean/engine-run"
import { isLeanProfile } from "@/backtest/lean/contracts"
import { runtimeForCandidate } from "@/backtest/lean/select"
import { leanSourceDir } from "@/backtest/lean/source-store"
import { readAlpacaCredentials, listAlpacaAccounts } from "@/live/brokers/alpaca"
import { readBinanceCredentials, listBinanceAccounts } from "@/live/brokers/binance"
import { readQcCredentials, isQcFixtureMode, QC_API_BASE, QC_PROVIDER_ID } from "./quantconnect"
import { getProjectLink } from "./qc-store"
import { syncBeforeRun, localSourceFilesForAlgorithm } from "./qc-sync"
import { qcBacktestUrl } from "./qc-contracts"
import {
  qcBacktestCreate,
  qcBacktestWait,
  qcCompileCreate,
  qcCompileWait,
  qcFileCreate,
  qcLiveCreate,
  qcLiveLiquidate,
  qcLiveRead,
  qcLiveStop,
  qcProjectCreate,
  qcProjectNodes,
  qcProjectsRead,
  qcProjectDelete,
  isLiveTerminal,
  type QcLiveDeployment,
} from "./qc-client"
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
  status: "starting" | "running" | "stopped"
  /** Raw QuantConnect live status observed at launch-poll completion. */
  qcStatus?: string
  projectId: string
  error?: string
  record?: QcPaperDeploymentRecord
}

export interface QcPaperDeploymentRecord {
  deploymentId: string
  algorithmName: string
  algorithmVersion: number
  projectId: string
  status: "starting" | "running" | "stopped"
  mode: "fixture" | "cloud"
  startedAt: string
  stoppedAt?: string
  compileId?: string
  brokerKind?: "qc_paper" | "alpaca" | "binance"
  liveUrl?: string
  error?: string
}

function paperLedgerFile(): string {
  const override = process.env.FINNY_QC_DEPLOYMENTS_FILE
  if (override) return override
  return path.join(Global.Path.data, "qc-paper-deployments.json")
}

export async function listPaperDeployments(): Promise<QcPaperDeploymentRecord[]> {
  try {
    return JSON.parse(await fs.readFile(paperLedgerFile(), "utf8")) as QcPaperDeploymentRecord[]
  } catch {
    return []
  }
}

async function writeDeployments(records: QcPaperDeploymentRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(paperLedgerFile()), { recursive: true })
  await fs.writeFile(paperLedgerFile(), JSON.stringify(records, null, 2), { flag: "w", mode: 0o600 })
}

async function appendDeployment(record: QcPaperDeploymentRecord): Promise<void> {
  const ledger = await listPaperDeployments()
  await writeDeployments([...ledger, record])
}

async function updateDeployment(
  deploymentId: string,
  patch: Partial<QcPaperDeploymentRecord>,
): Promise<QcPaperDeploymentRecord | null> {
  const ledger = await listPaperDeployments()
  const target = ledger.find((entry) => entry.deploymentId === deploymentId)
  if (!target) return null
  const updated: QcPaperDeploymentRecord = { ...target, ...patch }
  await writeDeployments(ledger.map((entry) => (entry.deploymentId === deploymentId ? updated : entry)))
  return updated
}

function sanitizeQcName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9 _-]/g, "-").replace(/\s+/g, " ").trim()
  return cleaned || "finny-algorithm"
}

/** Language for an unlinked QC push: the saved runtime profile wins, with
 *  the legacy algorithm language as a fallback for pre-runtime saves. */
export function qcPushLanguage(algorithm: Algorithm.Info): "python" | "csharp" {
  const runtimeProfileId = runtimeForCandidate(algorithm).profile.profileId
  return runtimeProfileId === "lean_csharp" || String(algorithm.language).toLowerCase() === "csharp"
    ? "csharp"
    : "python"
}

/**
 * Push the saved strategy into a QC project (fixture: deterministic local id).
 */
export async function pushStrategyToQc(input: {
  algorithm: Algorithm.Info
}): Promise<{ mode: "fixture" | "cloud"; projectId: string }> {
  const link = await getProjectLink(input.algorithm.algorithmId)
  if (link) {
    // A linked strategy must be source-synchronized before any remote action.
    const sync = await syncBeforeRun(input.algorithm)
    if (!sync.ok) {
      throw new Error(
        `QuantConnect project ${link.projectId} is not synchronized (${sync.action ?? "blocked"}). ` +
          (sync.drift?.length ? sync.drift.join("; ") : "Resolve drift before running."),
      )
    }
    return { mode: (await isQcFixtureMode()) ? "fixture" : "cloud", projectId: String(link.projectId) }
  }
  if ((await isQcFixtureMode())) {
    const hash = crypto.createHash("sha256").update(input.algorithm.algorithmId).digest("hex").slice(0, 24)
    return { mode: "fixture", projectId: `qc-fixture-${hash}` }
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  // Language comes from the saved runtime profile (or the algorithm language
  // for legacy saves) — a C# algorithm must never be pushed as a Python
  // project with C# bytes in main.py.
  const runtimeProfileId = runtimeForCandidate(input.algorithm).profile.profileId
  const language =
    runtimeProfileId === "lean_csharp" || String((input.algorithm as any).language).toLowerCase() === "csharp"
      ? "csharp"
      : "python"
  const { projectId } = await qcProjectCreate(credentials, {
    name: sanitizeQcName(`Finny ${input.algorithm.name} v${input.algorithm.version}`),
    language,
  })
  const files = link
    ? await linkedProjectSourceFiles({ algorithm: input.algorithm })
    : [{ path: language === "csharp" ? "Main.cs" : "main.py", content: input.algorithm.code }]
  for (const file of files) {
    await qcFileCreate(credentials, { projectId, name: file.path, content: file.content })
  }
  return { mode: "cloud", projectId: String(projectId) }
}

async function readQcFileContent(algorithm: Algorithm.Info, relativePath: string): Promise<string | null> {
  const { readLeanSourceFile } = await import("@/backtest/lean/source-store")
  try {
    return await readLeanSourceFile({ algorithm, relativePath })
  } catch {
    return null
  }
}

/** Language-aware source file set for a linked project (legacy helper). */
export async function linkedProjectSourceFiles(input: {
  algorithm: Algorithm.Info
}): Promise<Array<{ path: string; content: string }>> {
  const link = await getProjectLink(input.algorithm.algorithmId)
  if (!link) return [{ path: "main.py", content: input.algorithm.code }]
  const files = await localSourceFilesForAlgorithm(input.algorithm)
  const resolved: Array<{ path: string; content: string }> = []
  for (const file of files) {
    resolved.push({ path: file.path, content: (await readQcFileContent(input.algorithm, file.path)) ?? "" })
  }
  return resolved
}

export async function pushLinkedSourceToQc(input: {
  algorithm: Algorithm.Info
}): Promise<{ mode: "fixture" | "cloud"; projectId: string }> {
  const link = await getProjectLink(input.algorithm.algorithmId)
  if (!link) throw new Error("algorithm is not linked to a QuantConnect project")
  const sync = await syncBeforeRun(input.algorithm)
  if (!sync.ok) {
    throw new Error(
      `QuantConnect project ${link.projectId} is not synchronized (${sync.action ?? "blocked"}). ` +
        (sync.drift?.length ? sync.drift.join("; ") : "Resolve drift before deploying."),
    )
  }
  const { replaceRemoteFiles } = await import("./qc-sync")
  const local = await localSourceFilesForAlgorithm(input.algorithm)
  await replaceRemoteFiles(link.projectId, local, (relativePath) => readQcFileContent(input.algorithm, relativePath))
  return { mode: (await isQcFixtureMode()) ? "fixture" : "cloud", projectId: String(link.projectId) }
}

export interface QcLiveDeployInput {
  algorithm: Algorithm.Info
  projectId: string
  compileId: string
  nodeId: string
  brokerKind: "qc_paper" | "alpaca" | "binance"
  capital: number
  brokerProviderID?: string
  dataProviderId?: string
  versionId?: number | string
  parameters?: Record<string, unknown>
  abort?: AbortSignal
  /**
   * Managed deployments are recorded in the durable qc-control ledger by the
   * caller; this legacy paper ledger is only for the standalone QC CLI paths.
   */
  persistLegacy?: boolean
}

function liveUrl(projectId: number | string): string {
  return `https://www.quantconnect.com/project/${projectId}/live`
}

/**
 * Build the keyed brokerage settings block the QC /live/create endpoint
 * expects. Secrets come from Finny's stored brokerage accounts and are never
 * logged or written into run artifacts.
 */
export async function buildQcBrokerageSettings(input: {
  brokerKind: QcLiveDeployInput["brokerKind"]
  brokerProviderID?: string
  capital: number
  dataProviderId?: string
}): Promise<{ brokerage: Record<string, unknown>; dataProviders: Record<string, unknown> }> {
  if (input.brokerKind === "qc_paper") {
    return {
      brokerage: {
        QuantConnectBrokerageSettings: {
          id: "QuantConnectBrokerage",
          holdings: [],
          cash: [{ amount: input.capital, currency: "USD" }],
        },
      },
      dataProviders: { QuantConnectBrokerage: { id: "QuantConnectBrokerage" } },
    }
  }
  if (input.brokerKind === "alpaca") {
    const accounts = await listAlpacaAccounts()
    const providerID = input.brokerProviderID ?? accounts[0]?.providerID
    if (!providerID) throw new Error("No Alpaca account connected in Settings -> Brokerages")
    const creds = await readAlpacaCredentials(providerID)
    if (!creds) throw new Error(`Alpaca account ${providerID} is not readable; reconnect it in Settings`)
    const environment = creds.mode === "paper" ? "paper" : "live"
    const settings: Record<string, unknown> = {
      id: "AlpacaBrokerage",
      "alpaca-environment": environment,
    }
    if ((creds as any).accessToken) settings["alpaca-access-token"] = (creds as any).accessToken
    else {
      settings["alpaca-api-key"] = creds.keyId
      settings["alpaca-api-secret"] = creds.secret
    }
    const providerId = input.dataProviderId ?? "AlpacaDataQueueHandler"
    return {
      brokerage: { AlpacaBrokerageSettings: settings },
      dataProviders: { [providerId]: { id: providerId } },
    }
  }
  const accounts = await listBinanceAccounts()
  const providerID = input.brokerProviderID ?? accounts[0]?.providerID
  if (!providerID) throw new Error("No Binance account connected in Settings -> Brokerages")
  const creds = await readBinanceCredentials(providerID)
  if (!creds) throw new Error(`Binance account ${providerID} is not readable; reconnect it in Settings`)
  const providerId = input.dataProviderId ?? "BinanceBrokerage"
  return {
    brokerage: {
      BinanceBrokerageSettings: {
        id: "BinanceBrokerage",
        "binance-exchange-name": "Binance",
        "binance-api-key": creds.keyId,
        "binance-api-secret": creds.secret,
        "binance-use-testnet": creds.mode === "testnet" ? "paper" : "live",
      },
    },
    dataProviders: { [providerId]: { id: providerId } },
  }
}

/**
 * Deploy to QC Cloud live/paper execution. Requires an explicit live node;
 * the deployment is recorded in the durable ledger and its status is
 * reconciled by polling /live/read until a terminal state.
 */
export async function deployQcLive(input: QcLiveDeployInput): Promise<QcPaperDeployOutcome> {
  const persistLegacy = input.persistLegacy ?? true
  if ((await isQcFixtureMode())) {
    const project = { projectId: input.projectId }
    const deploymentId = `qc-deploy-${crypto.randomBytes(6).toString("hex")}`
    const record: QcPaperDeploymentRecord = {
      deploymentId,
      algorithmName: input.algorithm.name,
      algorithmVersion: input.algorithm.version,
      projectId: project.projectId,
      status: "running",
      mode: "fixture",
      brokerKind: input.brokerKind,
      startedAt: new Date().toISOString(),
    }
    if (persistLegacy) await appendDeployment(record)
    return { ok: true, mode: "fixture", deploymentId, status: "running", projectId: project.projectId }
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const { brokerage, dataProviders } = await buildQcBrokerageSettings({
    brokerKind: input.brokerKind,
    brokerProviderID: input.brokerProviderID,
    capital: input.capital,
    dataProviderId: input.dataProviderId,
  })
  const deployment = await qcLiveCreate(credentials, {
    projectId: Number(input.projectId),
    compileId: input.compileId,
    nodeId: input.nodeId,
    brokerage,
    dataProviders,
    versionId: input.versionId ?? -1,
    parameters: input.parameters ?? {},
  })
  const deploymentId = deployment.deployId
  if (!deploymentId) throw new Error("QuantConnect live create returned no deployId")
  const record: QcPaperDeploymentRecord = {
    deploymentId,
    algorithmName: input.algorithm.name,
    algorithmVersion: input.algorithm.version,
    projectId: String(input.projectId),
    // A deployment is only running once QuantConnect reports it as such; a
    // queued deployment starts as "starting" and is promoted by reconcile.
    status: "starting",
    mode: "cloud",
    brokerKind: input.brokerKind,
    startedAt: new Date().toISOString(),
    liveUrl: liveUrl(input.projectId),
  }
  if (persistLegacy) await appendDeployment(record)
  const status = await waitForLiveTerminal(credentials, { projectId: input.projectId, deployId: deploymentId }, input.abort)
  if (status.status === "Running") {
    await updateDeployment(deploymentId, { status: "running" })
  }
  const failed = status.status === "DeployError" || status.status === "RuntimeError" || status.status === "Invalid"
  if (failed) {
    await qcLiveStop(credentials, { projectId: input.projectId, deployId: deploymentId }).catch(() => undefined)
    const updated = await updateDeployment(deploymentId, { status: "stopped", error: status.message })
    return {
      ok: false,
      mode: "cloud",
      deploymentId,
      status: "stopped",
      projectId: String(input.projectId),
      error: status.message ?? `live deployment entered ${status.status}`,
      ...(updated ? { record: updated } : {}),
    }
  }
  // A poll timeout means the deployment never reached a terminal state or
  // Running within the window; the last observed status is InQueue with a
  // timeout message. Reporting "running" would misstate the deployment, so
  // it stays "starting" until a later reconciliation observes Running.
  const pending = status.status === "InQueue" || status.status === "Initializing" || status.status === "History"
  const running = status.status === "Running"
  return {
    ok: true,
    mode: "cloud",
    deploymentId,
    status: running ? "running" : pending ? "starting" : "stopped",
    qcStatus: status.status,
    projectId: String(input.projectId),
    ...(status.message ? { error: status.message } : {}),
  }
}

async function waitForLiveTerminal(
  credentials: Awaited<ReturnType<typeof readQcCredentials>>,
  input: { projectId: string; deployId: string },
  signal?: AbortSignal,
): Promise<QcLiveDeployment> {
  const deadlineMs = Number(process.env.FINNY_QC_LIVE_WAIT_MS ?? 10 * 60_000)
  const deadline = Date.now() + (Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 10 * 60_000)
  while (true) {
    signal?.throwIfAborted()
    const current = await qcLiveRead(credentials!, { projectId: input.projectId, deployId: input.deployId })
    if (!current) return { deployId: input.deployId, projectId: Number(input.projectId), status: "InQueue" }
    if (isLiveTerminal(current.status) || current.status === "Running") return current
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return { deployId: input.deployId, projectId: Number(input.projectId), status: "InQueue", message: "live status poll timed out" }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, remaining)))
  }
}

export async function stopQcLive(input: {
  projectId: string
  deploymentId: string
}): Promise<QcPaperDeployOutcome | null> {
  if ((await isQcFixtureMode())) {
    const updated = await updateDeployment(input.deploymentId, { status: "stopped", stoppedAt: new Date().toISOString() })
    if (!updated) return null
    return { ok: true, mode: "fixture", deploymentId: input.deploymentId, status: "stopped", projectId: input.projectId }
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const deployment = await qcLiveStop(credentials, { projectId: input.projectId, deployId: input.deploymentId })
  const updated = await updateDeployment(input.deploymentId, { status: "stopped", stoppedAt: new Date().toISOString() })
  if (!updated && !deployment) return null
  return {
    ok: true,
    mode: "cloud",
    deploymentId: input.deploymentId,
    status: "stopped",
    projectId: input.projectId,
    error: deployment?.message,
  }
}

export async function liquidateQcLive(input: {
  projectId: string
  deploymentId: string
}): Promise<QcPaperDeployOutcome | null> {
  if ((await isQcFixtureMode())) {
    const updated = await updateDeployment(input.deploymentId, { status: "stopped", stoppedAt: new Date().toISOString() })
    if (!updated) return null
    return { ok: true, mode: "fixture", deploymentId: input.deploymentId, status: "stopped", projectId: input.projectId }
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const deployment = await qcLiveLiquidate(credentials, { projectId: input.projectId, deployId: input.deploymentId })
  const updated = await updateDeployment(input.deploymentId, { status: "stopped", stoppedAt: new Date().toISOString() })
  if (!updated && !deployment) return null
  return {
    ok: true,
    mode: "cloud",
    deploymentId: input.deploymentId,
    status: "stopped",
    projectId: input.projectId,
    error: deployment?.message,
  }
}

export async function reconcileQcDeployments(): Promise<QcPaperDeploymentRecord[]> {
  if ((await isQcFixtureMode())) return listPaperDeployments()
  const credentials = await readQcCredentials()
  if (!credentials) return listPaperDeployments()
  const ledger = await listPaperDeployments()
  const active = ledger.filter(
    (entry) => entry.mode === "cloud" && (entry.status === "running" || entry.status === "starting"),
  )
  for (const entry of active) {
    const current = await qcLiveRead(credentials, { projectId: entry.projectId, deployId: entry.deploymentId })
    if (!current) continue
    // Promote a queued deployment only on an authoritative Running report.
    if (current.status === "Running" && entry.status === "starting") {
      await updateDeployment(entry.deploymentId, { status: "running" })
    }
    if (
      current.status === "Stopped" ||
      current.status === "Liquidated" ||
      current.status === "Deleted" ||
      current.status === "RuntimeError" ||
      current.status === "DeployError" ||
      current.status === "Invalid"
    ) {
      await updateDeployment(entry.deploymentId, {
        status: "stopped",
        stoppedAt: current.stopped ?? new Date().toISOString(),
        error: current.message,
      })
    }
  }
  return listPaperDeployments()
}

export async function listQcProjects(): Promise<Array<{ projectId: number; name: string; language: string; modified: string }>> {
  if ((await isQcFixtureMode())) return []
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const projects = await qcProjectsRead(credentials)
  return projects.map((project) => ({
    projectId: project.projectId,
    name: project.name,
    language: project.language,
    modified: project.modified,
  }))
}

export async function deleteQcProject(projectId: string): Promise<void> {
  if ((await isQcFixtureMode())) return
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  await qcProjectDelete(credentials, projectId)
}

export async function availableLiveNodes(projectId: string): Promise<Array<{ id: string; name: string; sku: string; busy: boolean }>> {
  if ((await isQcFixtureMode())) {
    return [
      { id: "LN-MICRO", name: "L-MICRO", sku: "L-MICRO", busy: false },
      { id: "LN-L1-1", name: "L1-1", sku: "L1-1", busy: false },
    ]
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const nodes = await qcProjectNodes(credentials, projectId)
  return nodes.live.all.map((node) => ({ id: node.id, name: node.name, sku: node.sku, busy: node.busy }))
}

export async function compileQcProject(input: {
  projectId: string
  abort?: AbortSignal
}): Promise<{ compileId: string; state: string; logs?: string[] }> {
  if ((await isQcFixtureMode())) {
    return { compileId: `qc-fixture-compile-${crypto.randomBytes(6).toString("hex")}`, state: "BuildSuccess" }
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const created = await qcCompileCreate(credentials, input.projectId)
  const result = await qcCompileWait(credentials, { projectId: input.projectId, compileId: created.compileId }, {
    timeoutMs: 10 * 60_000,
    signal: input.abort,
  })
  return { compileId: result.compileId, state: result.state, logs: result.logs }
}

function mapQcStatistics(statistics: Record<string, string | number> | undefined): Record<string, unknown> {
  if (!statistics) return {}
  const get = (key: string): string | number | undefined => statistics[key] ?? statistics[key.toLowerCase()]
  const num = (value: string | number | undefined): number | undefined => {
    if (value === undefined) return undefined
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%]/g, ""))
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return {
    total_return: num(get("Total Return")),
    sharpe: num(get("Sharpe Ratio")),
    max_drawdown: num(get("Drawdown")),
    total_trades: num(get("Total Trades")),
    net_profit: num(get("Net Profit")),
    fees: num(get("Fees")),
    unrealized: num(get("Unrealized")),
    equity: num(get("Equity")),
    raw: statistics,
  }
}

/**
 * Run a QC cloud backtest.
 *
 * Fixture mode executes the pinned local LEAN engine on deterministic data.
 * Cloud mode pushes the exact saved source tree, compiles it, runs the
 * backtest, and polls /backtests/read until completion.
 */
export async function runQcCloudBacktest(input: {
  algorithm: Algorithm.Info
  ohlcvCsv: string
  interval: string
  capital: number
  startDate: string
  endDate: string
  walkForwardFolds: number
  /** QC backtest parameters (GetParameter/get_parameter contract). */
  parameters?: Record<string, string | number>
  abort?: AbortSignal
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
    const totalReturn = outcome.v2.total_return
    const drawdown = outcome.v2.max_drawdown
    const netProfit = outcome.v2.ending_equity - input.capital
    return {
      ok: true,
      mode: "fixture",
      projectId: project.projectId,
      backtestId: `qc-fixture-bt-${crypto.randomBytes(6).toString("hex")}`,
      stats: {
        // Percent units, matching the cloud leg's mapped statistics so the
        // same field means the same thing in both modes.
        total_return: totalReturn * 100,
        sharpe: outcome.v2.ann_sharpe,
        max_drawdown: drawdown * 100,
        total_trades: outcome.v2.total_trades,
        net_profit: netProfit,
        equity: outcome.v2.ending_equity,
        engine: outcome.v2.engine_version,
        mode: "fixture",
        // Canonical QC-style keys so canonicalizeQcStatistics() resolves the
        // same numeric units the cloud leg's raw statistics produce.
        raw: {
          "Total Return": `${(totalReturn * 100).toFixed(2)}%`,
          "Sharpe Ratio": String(outcome.v2.ann_sharpe),
          "Drawdown": `${(drawdown * 100).toFixed(2)}%`,
          "Total Trades": String(outcome.v2.total_trades),
          "Net Profit": `${netProfit.toFixed(2)}`,
          "Equity": `${outcome.v2.ending_equity.toFixed(2)}`,
        },
      },
    }
  }

  const credentials = await readQcCredentials()
  if (!credentials) {
    return { ok: false, mode: "cloud", projectId: project.projectId, error: "QuantConnect credentials are not connected" }
  }
  try {
    const compile = await compileQcProject({ projectId: project.projectId, abort: input.abort })
    if (compile.state !== "BuildSuccess") {
      return {
        ok: false,
        mode: "cloud",
        projectId: project.projectId,
        error: `QuantConnect compile failed (${compile.state}): ${(compile.logs ?? []).slice(-5).join("\n")}`,
      }
    }
    const created = await qcBacktestCreate(credentials, {
      projectId: project.projectId,
      compileId: compile.compileId,
      name: sanitizeQcName(`finny ${input.algorithm.name} ${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`),
      ...(input.parameters ? { parameters: input.parameters } : {}),
    })
    const result = await qcBacktestWait(
      credentials,
      { projectId: project.projectId, backtestId: created.backtestId },
      { timeoutMs: 30 * 60_000, signal: input.abort },
    )
    if (result.status !== "Completed.") {
      return {
        ok: false,
        mode: "cloud",
        projectId: project.projectId,
        backtestId: result.backtestId,
        error: result.error ?? `QuantConnect backtest ended with status ${result.status}`,
      }
    }
    return {
      ok: true,
      mode: "cloud",
      projectId: project.projectId,
      backtestId: result.backtestId,
      stats: {
        ...mapQcStatistics(result.statistics),
        backtest_id: result.backtestId,
        status: result.status,
        progress: result.progress,
        engine: "qc-cloud",
        mode: "cloud",
        backtest_url: qcBacktestUrl(project.projectId, result.backtestId),
      },
    }
  } catch (error) {
    return {
      ok: false,
      mode: "cloud",
      projectId: project.projectId,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Deploy paper execution through QC Cloud (QuantConnect Paper brokerage).
 */
export async function deployQcPaper(input: {
  algorithm: Algorithm.Info
}): Promise<QcPaperDeployOutcome> {
  const project = await pushStrategyToQc({ algorithm: input.algorithm })
  if (project.mode === "fixture") {
    return deployQcLive({
      algorithm: input.algorithm,
      projectId: project.projectId,
      compileId: `qc-fixture-compile-${crypto.randomBytes(6).toString("hex")}`,
      nodeId: "LN-MICRO",
      brokerKind: "qc_paper",
      capital: 10000,
    })
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const compile = await compileQcProject({ projectId: project.projectId })
  if (compile.state !== "BuildSuccess") {
    return {
      ok: false,
      mode: "cloud",
      deploymentId: "",
      status: "stopped",
      projectId: project.projectId,
      error: `QuantConnect compile failed (${compile.state})`,
    }
  }
  const nodes = await availableLiveNodes(project.projectId)
  const node = nodes.find((candidate) => !candidate.busy) ?? nodes[0]
  if (!node) {
    return {
      ok: false,
      mode: "cloud",
      deploymentId: "",
      status: "stopped",
      projectId: project.projectId,
      error: "No live node available for this project; add one in QuantConnect first",
    }
  }
  return deployQcLive({
    algorithm: input.algorithm,
    projectId: project.projectId,
    compileId: compile.compileId,
    nodeId: node.id,
    brokerKind: "qc_paper",
    capital: 10000,
  })
}

export async function stopQcPaper(deploymentId: string): Promise<QcPaperDeployOutcome | null> {
  const ledger = await listPaperDeployments()
  const target = ledger.find((entry) => entry.deploymentId === deploymentId)
  if (!target) return null
  return stopQcLive({ projectId: target.projectId, deploymentId })
}

export { QC_API_BASE, QC_PROVIDER_ID }
