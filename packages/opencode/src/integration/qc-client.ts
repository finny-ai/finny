import { type QcCredentials, qcApiRequest } from "./quantconnect"

/**
 * Typed QuantConnect Cloud v2 REST client used by the QC Cloud execution track.
 *
 * Every function requires verified credentials (see ./quantconnect for the
 * timestamped-hash authentication scheme). Responses are parsed defensively
 * because QC's API surfaces both `success:false` bodies and HTTP errors, and
 * several endpoints return slightly different shapes depending on the caller.
 */

export interface QcProject {
  projectId: number
  organizationId: string
  name: string
  language: string
  ownerId: number
  modified: string
  created: string
  leanVersionId: number
  description?: string
  parameters?: Record<string, unknown>
  libraries?: Array<{ projectId: number; libraryName: string; access: boolean }>
  lastLiveDeployment?: string
}

export interface QcNode {
  id: string
  name: string
  sku: string
  active: boolean
  busy: boolean
  ram: number
  cpu: number
  hasGpu: number
  description?: string
}

export interface QcNodeSet {
  all: QcNode[]
  selected?: string
}

export interface QcProjectNodes {
  backtest: QcNodeSet
  live: QcNodeSet
  autoSelectNode: boolean
}

export type QcCompileState = "InQueue" | "BuildSuccess" | "BuildError" | string

export interface QcCompileResult {
  compileId: string
  state: QcCompileState
  logs?: string[]
}

export interface QcBacktestResult {
  backtestId: string
  name?: string
  status: string
  progress: number
  created?: string
  statistics?: Record<string, string | number>
  error?: string
}

export type QcLiveStatus =
  | "DeployError"
  | "InQueue"
  | "Running"
  | "Stopped"
  | "Liquidated"
  | "Deleted"
  | "Completed"
  | "RuntimeError"
  | "Invalid"
  | "LoggingIn"
  | "Initializing"
  | "History"

export interface QcLiveDeployment {
  deployId: string
  projectId: number
  status: QcLiveStatus
  launched?: string
  stopped?: string
  brokerage?: string
  securityTypes?: string
  runtimeStatistics?: Record<string, string>
  charts?: Array<{ name: string }>
  message?: string
}

export interface QcLiveCreateInput {
  projectId: number
  compileId: string
  nodeId: string
  brokerage: Record<string, unknown>
  dataProviders?: Record<string, unknown>
  versionId?: number | string
  parameters?: Record<string, unknown>
  notification?: Record<string, unknown>
}

const COMPILE_TERMINAL: ReadonlySet<string> = new Set(["BuildSuccess", "BuildError"])
const BACKTEST_TERMINAL: ReadonlySet<string> = new Set(["Completed.", "Runtime Error", "Stopped."])
const LIVE_TERMINAL: ReadonlySet<string> = new Set([
  "Running",
  "Stopped",
  "Liquidated",
  "Deleted",
  "Completed",
  "RuntimeError",
  "DeployError",
  "Invalid",
])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor<T>(
  label: string,
  poll: () => Promise<{ done: boolean; value: T }>,
  options: { timeoutMs: number; intervalMs: number; signal?: AbortSignal },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs
  while (true) {
    options.signal?.throwIfAborted()
    const { done, value } = await poll()
    if (done) return value
    if (Date.now() >= deadline) throw new Error(`${label} timed out after ${options.timeoutMs}ms`)
    await sleep(options.intervalMs)
  }
}

function projectIdOrThrow(input: { projectId: number | string }): number {
  const id = Number(input.projectId)
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid QuantConnect project id: ${input.projectId}`)
  return id
}

export async function qcProjectsRead(
  credentials: QcCredentials,
  projectId?: number | string,
): Promise<QcProject[]> {
  const body = await qcApiRequest({
    path: "/projects/read",
    credentials,
    body: projectId === undefined ? {} : { projectId: projectIdOrThrow({ projectId }) },
  })
  const raw = Array.isArray(body.projects) ? body.projects : []
  return raw.map((entry: Record<string, any>) => ({
    projectId: Number(entry.projectId),
    organizationId: String(entry.organizationId ?? ""),
    name: String(entry.name ?? ""),
    language: String(entry.language ?? ""),
    ownerId: Number(entry.ownerId ?? 0),
    modified: String(entry.modified ?? ""),
    created: String(entry.created ?? ""),
    leanVersionId: Number(entry.leanVersionId ?? 0),
    description: entry.description === null || entry.description === undefined ? undefined : String(entry.description),
    parameters: entry.parameters,
    libraries: entry.libraries,
    lastLiveDeployment: entry.lastLiveDeployment === null ? undefined : String(entry.lastLiveDeployment),
  }))
}

export async function qcProjectCreate(
  credentials: QcCredentials,
  input: { name: string; language: "python" | "csharp" },
): Promise<{ projectId: number; project: QcProject }> {
  const body = await qcApiRequest({
    path: "/projects/create",
    credentials,
    body: { name: input.name, language: input.language === "csharp" ? "C#" : "Py" },
  })
  const project = Array.isArray(body.projects) ? body.projects[0] : body.project
  const projectId = Number(project?.projectId ?? body.projectId)
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error("QuantConnect project create returned no valid projectId")
  }
  return {
    projectId,
    project: {
      projectId,
      organizationId: String(project?.organizationId ?? ""),
      name: String(project?.name ?? input.name),
      language: String(project?.language ?? input.language),
      ownerId: Number(project?.ownerId ?? 0),
      modified: String(project?.modified ?? ""),
      created: String(project?.created ?? ""),
      leanVersionId: Number(project?.leanVersionId ?? 0),
    },
  }
}

export async function qcProjectDelete(credentials: QcCredentials, projectId: number | string): Promise<void> {
  await qcApiRequest({ path: "/projects/delete", credentials, body: { projectId: projectIdOrThrow({ projectId }) } })
}

export async function qcProjectNodes(
  credentials: QcCredentials,
  projectId: number | string,
): Promise<QcProjectNodes> {
  const body = await qcApiRequest({
    path: "/projects/nodes/read",
    credentials,
    body: { projectId: projectIdOrThrow({ projectId }) },
  })
  const nodes = (body.nodes ?? {}) as Record<string, any>
  const mapSet = (raw: any): QcNodeSet => {
    const entries = Array.isArray(raw?.all) ? raw.all : Array.isArray(raw) ? raw : []
    return {
      all: entries.map((node: Record<string, any>) => ({
        id: String(node.id ?? node.name ?? ""),
        name: String(node.name ?? node.id ?? ""),
        sku: String(node.sku ?? node.specification ?? ""),
        active: Boolean(node.active ?? true),
        busy: Boolean(node.busy ?? false),
        ram: Number(node.ram ?? 0),
        cpu: Number(node.cpu ?? 0),
        hasGpu: Number(node.hasGpu ?? 0),
        description: node.description === null || node.description === undefined ? undefined : String(node.description),
      })),
      selected: raw?.selected === null || raw?.selected === undefined ? undefined : String(raw.selected),
    }
  }
  return {
    backtest: mapSet(nodes.backtest),
    live: mapSet(nodes.live),
    autoSelectNode: Boolean(nodes.autoSelectNode ?? body.autoSelectNode ?? false),
  }
}

export async function qcFileCreate(
  credentials: QcCredentials,
  input: { projectId: number | string; name: string; content: string },
): Promise<void> {
  await qcApiRequest({
    path: "/files/create",
    credentials,
    body: { projectId: projectIdOrThrow(input), name: input.name, content: input.content, codeSourceId: "Finny" },
  })
}

export async function qcFileUpdate(
  credentials: QcCredentials,
  input: { projectId: number | string; name: string; content: string },
): Promise<void> {
  await qcApiRequest({
    path: "/files/update",
    credentials,
    body: { projectId: projectIdOrThrow(input), name: input.name, content: input.content, codeSourceId: "Finny" },
  })
}

export async function qcFilesRead(
  credentials: QcCredentials,
  input: { projectId: number | string; name?: string; includeLibraries?: boolean },
): Promise<Array<{ name: string; content: string; modified?: string }>> {
  const body = await qcApiRequest({
    path: "/files/read",
    credentials,
    body: {
      projectId: projectIdOrThrow(input),
      name: input.name,
      includeLibraries: input.includeLibraries ?? false,
      codeSourceId: "Finny",
    },
  })
  const files = Array.isArray(body.files) ? body.files : []
  return files.map((entry: Record<string, any>) => ({
    name: String(entry.name ?? ""),
    content: String(entry.content ?? ""),
    modified: entry.modified === null || entry.modified === undefined ? undefined : String(entry.modified),
  }))
}

export async function qcCompileCreate(
  credentials: QcCredentials,
  projectId: number | string,
): Promise<QcCompileResult> {
  const body = await qcApiRequest({ path: "/compile/create", credentials, body: { projectId: projectIdOrThrow({ projectId }) } })
  const compileId = String(body.compileId ?? body.compile?.compileId ?? "")
  if (!compileId) throw new Error("QuantConnect compile returned no compileId")
  return {
    compileId,
    state: String(body.state ?? body.compile?.state ?? "InQueue"),
    logs: Array.isArray(body.logs) ? body.logs.map(String) : undefined,
  }
}

export async function qcCompileRead(
  credentials: QcCredentials,
  input: { projectId: number | string; compileId: string },
): Promise<QcCompileResult> {
  const body = await qcApiRequest({
    path: "/compile/read",
    credentials,
    body: { projectId: projectIdOrThrow(input), compileId: input.compileId },
  })
  const compile = (body.compile ?? body) as Record<string, any>
  return {
    compileId: String(compile.compileId ?? input.compileId),
    state: String(compile.state ?? "InQueue"),
    logs: Array.isArray(compile.logs) ? compile.logs.map(String) : undefined,
  }
}

export async function qcCompileWait(
  credentials: QcCredentials,
  input: { projectId: number | string; compileId: string },
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<QcCompileResult> {
  return waitFor<QcCompileResult>(
    "QuantConnect compile",
    async () => {
      const result = await qcCompileRead(credentials, input)
      return { done: COMPILE_TERMINAL.has(result.state), value: result }
    },
    { timeoutMs: options.timeoutMs ?? 10 * 60_000, intervalMs: options.intervalMs ?? 2_000, signal: options.signal },
  )
}

export async function qcBacktestCreate(
  credentials: QcCredentials,
  input: { projectId: number | string; compileId: string; name: string },
): Promise<{ backtestId: string }> {
  const body = await qcApiRequest({
    path: "/backtests/create",
    credentials,
    body: { projectId: projectIdOrThrow(input), compileId: input.compileId, backtestName: input.name },
  })
  const backtest = Array.isArray(body.backtests) ? body.backtests[0] : body.backtest ?? body
  const backtestId = String(backtest?.backtestId ?? "")
  if (!backtestId) throw new Error("QuantConnect backtest create returned no backtestId")
  return { backtestId }
}

export async function qcBacktestRead(
  credentials: QcCredentials,
  input: { projectId: number | string; backtestId: string },
): Promise<QcBacktestResult> {
  const body = await qcApiRequest({
    path: "/backtests/read",
    credentials,
    body: { projectId: projectIdOrThrow(input), backtestId: input.backtestId },
  })
  const backtest = (body.backtests?.[0] ?? body.backtest ?? body) as Record<string, any>
  return {
    backtestId: String(backtest.backtestId ?? input.backtestId),
    name: backtest.name === null || backtest.name === undefined ? undefined : String(backtest.name),
    status: String(backtest.status ?? "In Progress..."),
    progress: Number(backtest.progress ?? 0),
    created: backtest.created === null || backtest.created === undefined ? undefined : String(backtest.created),
    statistics: backtest.statistics,
    error: backtest.error === null || backtest.error === undefined ? undefined : String(backtest.error),
  }
}

export async function qcBacktestWait(
  credentials: QcCredentials,
  input: { projectId: number | string; backtestId: string },
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<QcBacktestResult> {
  return waitFor<QcBacktestResult>(
    "QuantConnect backtest",
    async () => {
      const result = await qcBacktestRead(credentials, input)
      return { done: BACKTEST_TERMINAL.has(result.status), value: result }
    },
    { timeoutMs: options.timeoutMs ?? 30 * 60_000, intervalMs: options.intervalMs ?? 5_000, signal: options.signal },
  )
}

export async function qcLiveCreate(
  credentials: QcCredentials,
  input: QcLiveCreateInput,
): Promise<QcLiveDeployment> {
  const body = await qcApiRequest({
    path: "/live/create",
    credentials,
    body: {
      versionId: input.versionId ?? -1,
      projectId: input.projectId,
      compileId: input.compileId,
      nodeId: input.nodeId,
      brokerage: input.brokerage,
      dataProviders: input.dataProviders ?? {},
      parameters: input.parameters ?? {},
      notification: input.notification ?? {},
    },
  })
  return qcLiveFromBody(body, input.projectId)
}

export async function qcLiveRead(
  credentials: QcCredentials,
  input: { projectId?: number | string; deployId?: string },
): Promise<QcLiveDeployment | undefined> {
  const body = await qcApiRequest({
    path: "/live/read",
    credentials,
    body: {
      projectId: input.projectId === undefined ? undefined : projectIdOrThrow({ projectId: input.projectId }),
      deployId: input.deployId,
    },
  })
  const live = (body.live ?? body) as Record<string, any>
  if (!live || !live.deployId) return undefined
  return qcLiveFromBody(body, input.projectId ?? live.projectId)
}

export async function qcLiveList(
  credentials: QcCredentials,
  input: { projectId?: number | string; status?: string } = {},
): Promise<QcLiveDeployment[]> {
  const body = await qcApiRequest({
    path: "/live/list",
    credentials,
    body: {
      projectId: input.projectId === undefined ? undefined : projectIdOrThrow({ projectId: input.projectId }),
      status: input.status,
    },
  })
  const raw = Array.isArray(body.live) ? body.live : Array.isArray(body.lives) ? body.lives : []
  return raw
    .map((entry: Record<string, any>) => qcLiveFromBody({ live: entry }, entry.projectId))
    .filter((entry) => Boolean(entry.deployId))
}

export async function qcLiveStop(
  credentials: QcCredentials,
  input: { projectId: number | string; deployId: string },
): Promise<QcLiveDeployment | undefined> {
  const body = await qcApiRequest({
    path: "/live/stop",
    credentials,
    body: { projectId: projectIdOrThrow(input), deployId: input.deployId },
  })
  return body.live ? qcLiveFromBody(body, input.projectId) : undefined
}

export async function qcLiveLiquidate(
  credentials: QcCredentials,
  input: { projectId: number | string; deployId: string },
): Promise<QcLiveDeployment | undefined> {
  const body = await qcApiRequest({
    path: "/live/liquidate",
    credentials,
    body: { projectId: projectIdOrThrow(input), deployId: input.deployId },
  })
  return body.live ? qcLiveFromBody(body, input.projectId) : undefined
}

function qcLiveFromBody(body: Record<string, any>, fallbackProjectId?: number | string): QcLiveDeployment {
  const live = (body.live ?? body) as Record<string, any>
  return {
    deployId: String(live.deployId ?? ""),
    projectId: Number(live.projectId ?? fallbackProjectId ?? 0),
    status: String(live.status ?? "InQueue") as QcLiveStatus,
    launched: live.launched === null || live.launched === undefined ? undefined : String(live.launched),
    stopped: live.stopped === null || live.stopped === undefined ? undefined : String(live.stopped),
    brokerage: live.brokerage === null || live.brokerage === undefined ? undefined : String(live.brokerage),
    securityTypes: live.securityTypes === null || live.securityTypes === undefined ? undefined : String(live.securityTypes),
    runtimeStatistics: live.runtimeStatistics,
    charts: live.charts,
    message: live.message === null || live.message === undefined ? undefined : String(live.message),
  }
}

export function isLiveTerminal(status: string): boolean {
  return LIVE_TERMINAL.has(status)
}
