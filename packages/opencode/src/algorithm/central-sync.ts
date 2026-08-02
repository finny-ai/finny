import crypto from "node:crypto"
import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import type { Algorithm } from "."
import type { BacktestStore } from "@/backtest/store"
import { verifyStrictRunDir } from "@/backtest/run-integrity-verify"
import { Log } from "@/util/log"
import { AlgorithmVersionPackage, VERSION_MAX_TOTAL_BYTES, type CatalogMetadata } from "./version-package"

export type Mode = "off" | "required"
export type PublishStatus = "disabled" | "published"

const DEFAULT_HTTP_TIMEOUT_MS = 30_000
const DEFAULT_OUTBOX_RETRY_INTERVAL_MS = 60_000
export const VERSION_BUNDLE_MAX_DOWNLOAD_BYTES = VERSION_MAX_TOTAL_BYTES + 1024 * 1024
export const STRICT_EVIDENCE_MAX_ENTRIES = 4_096
export const STRICT_EVIDENCE_MAX_ENTRY_BYTES = 256 * 1024 * 1024
export const STRICT_EVIDENCE_DEFAULT_TOTAL_BYTES = 256 * 1024 * 1024

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const PackageFile = z.object({ path: z.string().min(1), sha256: Hash, bytes: z.number().int().nonnegative() })
const VersionPublication = z.object({
  schema: z.literal("finny.algorithm_version_publication"),
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().min(1),
  sourceSessionId: z.string().min(1).optional(),
  algorithm: z.object({
    algorithmId: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
    status: z.string().min(1),
    language: z.string().min(1),
    description: z.string().optional(),
    brokerKind: z.string().trim().min(1).max(128).optional(),
    targetBrokerage: z.string().trim().min(1).max(128).optional(),
    timeCreated: z.number(),
    timeUpdated: z.number(),
  }),
  package: z.object({
    payloadHash: Hash,
    archiveSha256: Hash,
    bytes: z.number().int().nonnegative(),
    files: z.array(PackageFile),
  }),
})
export type VersionPublication = z.infer<typeof VersionPublication>

const BacktestPublication = z.object({
  schema: z.literal("finny.backtest_publication"),
  schemaVersion: z.literal(1),
  idempotencyKey: z.string().min(1),
  sourceSessionId: z.string().min(1).optional(),
  algorithmId: z.string().min(1),
  algorithmVersion: z.number().int().nonnegative(),
  run: z.object({
    runId: z.string().min(1),
    status: z.string().min(1),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    evidenceAvailable: z.boolean().optional(),
    evidenceUnavailableReason: z.string().optional(),
  }),
  parameters: z.record(z.string(), z.unknown()),
  metrics: z.record(z.string(), z.unknown()),
  execution: z.record(z.string(), z.unknown()).optional(),
  broker: z.record(z.string(), z.unknown()).optional(),
})
export type BacktestPublication = z.infer<typeof BacktestPublication>

const OutboxItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("version"),
    publication: VersionPublication,
    archiveBase64: z.string(),
    outboxRevision: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("backtest"),
    publication: BacktestPublication,
    evidenceBase64: z.string().optional(),
  }),
])
export type OutboxItem = z.infer<typeof OutboxItem>

export interface Transport {
  publishVersion(input: { publication: VersionPublication; bundle: Uint8Array }): Promise<void>
  publishBacktest(input: { publication: BacktestPublication; evidence?: Uint8Array }): Promise<void>
  downloadVersion?(input: {
    algorithmId: string
    version: number
  }): Promise<{ catalog: CatalogMetadata; bundle: Uint8Array }>
}

interface PlatformConfig {
  baseUrl: string
  token: string
}

interface BoundedFetchRequest<T> {
  url: string
  init: RequestInit
  consume: (response: Response) => Promise<T>
}

interface RequestTimeout {
  clear(): void
  hasTimedOut(): boolean
}

interface StrictEvidenceLimits {
  totalBytes: number
  entryBytes: number
  maxEntries: number
}

interface StrictEvidenceEntry {
  relative: string
  file: string
  bytes: number
}

interface StrictEvidenceScan {
  root: string
  limits: StrictEvidenceLimits
  entries: StrictEvidenceEntry[]
  totalBytes: number
}

interface QueuedOutboxItem {
  file: string
  item: OutboxItem
}

interface MaterializeVersionRequest {
  algorithmId: string
  version: number
}

interface DownloadedVersion {
  catalog: CatalogMetadata
  bundle: Uint8Array
}

export class CentralSyncError extends Error {}

export class PreflightError extends CentralSyncError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CentralSyncPreflightError"
  }
}

export class TransportTimeoutError extends CentralSyncError {
  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`Finny Platform request timed out after ${timeoutMs}ms`, options)
    this.name = "CentralSyncTransportTimeoutError"
  }
}

export class PublishError extends CentralSyncError {
  readonly outboxPath: string

  constructor(message: string, outboxPath: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CentralPublishError"
    this.outboxPath = outboxPath
  }
}

let testTransport: Transport | undefined
let outboxRetryTimer: ReturnType<typeof setInterval> | undefined
let outboxRetryInFlight: Promise<void> | undefined
let lastOutboxRevision = 0
const log = Log.create({ service: "algorithm.central-sync" })

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`
}

function sha256(input: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function resolvedSourceSessionId(explicit?: string): string | undefined {
  return (
    explicit?.trim() ||
    process.env.OMNIGENT_SESSION_ID?.trim() ||
    process.env.FINNY_MAIN_SESSION_ID?.trim() ||
    undefined
  )
}

export function mode(env: NodeJS.ProcessEnv = process.env): Mode {
  const value = env.FINNY_PLATFORM_SYNC_MODE?.trim().toLowerCase() || "off"
  if (value === "off" || value === "required") return value
  throw new Error(`Invalid FINNY_PLATFORM_SYNC_MODE: ${value}`)
}

function outboxDir(): string {
  return path.join(path.dirname(finnyArtifactPath("algorithms")), "central-sync", "outbox")
}

function outboxPath(item: OutboxItem): string {
  return path.join(outboxDir(), `${sha256(item.publication.idempotencyKey)}.json`)
}

async function writeAtomicExclusive(file: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, content, { flag: "wx" })
    try {
      await fs.link(temporary, file)
      return true
    } catch (error: any) {
      if (error?.code === "EEXIST") return false
      throw error
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function persistOutbox(item: OutboxItem): Promise<{ file: string; item: OutboxItem }> {
  const file = outboxPath(item)
  const serialized = `${stableStringify(item)}\n`
  const existing = await fs.readFile(file, "utf8").catch((error: any) => {
    if (error?.code === "ENOENT") return undefined
    throw error
  })
  if (existing !== undefined) return { file, item: OutboxItem.parse(JSON.parse(existing)) }
  if (await writeAtomicExclusive(file, serialized)) return { file, item }
  return { file, item: OutboxItem.parse(JSON.parse(await fs.readFile(file, "utf8"))) }
}

function sameVersionPackage(left: VersionPublication, right: VersionPublication): boolean {
  return (
    left.algorithm.algorithmId === right.algorithm.algorithmId &&
    left.algorithm.version === right.algorithm.version &&
    left.package.payloadHash === right.package.payloadHash &&
    left.package.archiveSha256 === right.package.archiveSha256
  )
}

function nextOutboxRevision(): number {
  const wallClockRevision = Date.now() * 1_000
  lastOutboxRevision = Math.max(wallClockRevision, lastOutboxRevision + 1)
  return lastOutboxRevision
}

function newerVersionPublication(left: QueuedOutboxItem, right: QueuedOutboxItem): QueuedOutboxItem {
  if (left.item.kind !== "version") return right
  if (right.item.kind !== "version") return left
  if (left.item.publication.algorithm.timeUpdated !== right.item.publication.algorithm.timeUpdated) {
    return left.item.publication.algorithm.timeUpdated > right.item.publication.algorithm.timeUpdated ? left : right
  }
  const leftRevision = left.item.outboxRevision ?? 0
  const rightRevision = right.item.outboxRevision ?? 0
  if (leftRevision !== rightRevision) return leftRevision > rightRevision ? left : right
  return left.item.publication.idempotencyKey >= right.item.publication.idempotencyKey ? left : right
}

async function currentVersionOutboxItem(persisted: QueuedOutboxItem): Promise<QueuedOutboxItem> {
  if (persisted.item.kind !== "version") return persisted
  const queue = await readOutboxQueue(await outboxEntryNames())
  const siblings = queue.queued.filter(
    (queued) =>
      queued.item.kind === "version" && sameVersionPackage(queued.item.publication, persisted.item.publication),
  )
  const current = siblings.reduce(newerVersionPublication, persisted)
  for (const sibling of siblings) {
    if (sibling.file === current.file) continue
    await fs.rm(sibling.file, { force: true })
  }
  return current
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new PreflightError(`${name} must be a positive integer`)
  return value
}

function httpTimeoutMs(): number {
  return positiveIntegerEnv("FINNY_PLATFORM_HTTP_TIMEOUT_MS", DEFAULT_HTTP_TIMEOUT_MS)
}

function versionBundleMaxDownloadBytes(): number {
  return positiveIntegerEnv("FINNY_PLATFORM_VERSION_BUNDLE_MAX_BYTES", VERSION_BUNDLE_MAX_DOWNLOAD_BYTES)
}

function linkAbortSignal(input: { source?: AbortSignal | null; target: AbortController }): () => void {
  const { source, target } = input
  if (!source) return () => undefined
  const relay = () => target.abort(source.reason)
  if (source.aborted) relay()
  else source.addEventListener("abort", relay, { once: true })
  return () => source.removeEventListener("abort", relay)
}

function startRequestTimeout(input: { controller: AbortController; timeoutMs: number }): RequestTimeout {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    input.controller.abort(new TransportTimeoutError(input.timeoutMs))
  }, input.timeoutMs)
  return {
    clear: () => clearTimeout(timer),
    hasTimedOut: () => timedOut,
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new CentralSyncError("Finny Platform request aborted"))
    if (signal.aborted) rejectAbort()
    else signal.addEventListener("abort", rejectAbort, { once: true })
  })
}

async function withBoundedFetch<T>(request: BoundedFetchRequest<T>): Promise<T> {
  const timeoutMs = httpTimeoutMs()
  const controller = new AbortController()
  const unlinkAbortSignal = linkAbortSignal({ source: request.init.signal, target: controller })
  const timeout = startRequestTimeout({ controller, timeoutMs })
  try {
    return await Promise.race([
      (async () => request.consume(await fetch(request.url, { ...request.init, signal: controller.signal })))(),
      rejectWhenAborted(controller.signal),
    ])
  } catch (error) {
    if (timeout.hasTimedOut()) throw new TransportTimeoutError(timeoutMs, { cause: error })
    throw error
  } finally {
    timeout.clear()
    unlinkAbortSignal()
  }
}

function platformBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.FINNY_PLATFORM_URL?.trim() || env.OMNIGENT_POLICY_URL?.trim()
  return configured?.replace(/\/+$/, "")
}

function parseBearerToken(auth: string | undefined): string | undefined {
  if (!auth) return undefined
  return /^Bearer ([^\s]+)$/.exec(auth.trim())?.[1]
}

function platformBearerToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.FINNY_PLATFORM_ACCESS_TOKEN?.trim() || parseBearerToken(env.OMNIGENT_POLICY_AUTH)
}

function platformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const baseUrl = platformBaseUrl(env)
  if (!baseUrl) {
    throw new Error("FINNY_PLATFORM_URL or OMNIGENT_POLICY_URL is required when central sync is enabled")
  }
  const token = platformBearerToken(env)
  if (!token) {
    throw new Error(
      "FINNY_PLATFORM_ACCESS_TOKEN or a valid Bearer token in OMNIGENT_POLICY_AUTH is required when central sync is enabled",
    )
  }
  return { baseUrl, token }
}

async function expectSuccess(response: Response): Promise<void> {
  if (response.ok) return
  const detail = (await response.text().catch(() => "")).slice(0, 500)
  throw new Error(`Finny Platform publication failed (${response.status})${detail ? `: ${detail}` : ""}`)
}

async function readBoundedResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const bytes = Number(declaredLength)
    if (Number.isFinite(bytes) && bytes > maximumBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new PreflightError(`Downloaded algorithm version bundle exceeds ${maximumBytes} bytes`)
    }
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      totalBytes += next.value.byteLength
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new PreflightError(`Downloaded algorithm version bundle exceeds ${maximumBytes} bytes`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function defaultTransport(): Transport {
  const { baseUrl, token } = platformConfig()
  return {
    async publishVersion({ publication, bundle }) {
      const body = new FormData()
      body.set("publication", JSON.stringify(publication))
      body.set(
        "bundle",
        new Blob([Uint8Array.from(bundle).buffer], { type: "application/zip" }),
        "algorithm-version.zip",
      )
      await withBoundedFetch({
        url: `${baseUrl}/api/finny/algorithms/${encodeURIComponent(publication.algorithm.algorithmId)}/versions`,
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        },
        consume: expectSuccess,
      })
    },
    async publishBacktest({ publication, evidence }) {
      const body = new FormData()
      body.set("publication", JSON.stringify(publication))
      if (evidence) {
        body.set(
          "evidence",
          new Blob([Uint8Array.from(evidence).buffer], { type: "application/zip" }),
          "backtest-evidence.zip",
        )
      }
      await withBoundedFetch({
        url: `${baseUrl}/api/finny/algorithms/${encodeURIComponent(publication.algorithmId)}/versions/${publication.algorithmVersion}/backtests`,
        init: { method: "POST", headers: { authorization: `Bearer ${token}` }, body },
        consume: expectSuccess,
      })
    },
    async downloadVersion({ algorithmId, version }) {
      const sourceSessionId = resolvedSourceSessionId()
      if (!sourceSessionId) {
        throw new Error(
          "OMNIGENT_SESSION_ID or FINNY_MAIN_SESSION_ID is required to download a central algorithm version",
        )
      }
      const root = `${baseUrl}/api/finny/algorithms/${encodeURIComponent(algorithmId)}/versions/${version}`
      const headers = {
        authorization: `Bearer ${token}`,
        "x-finny-source-session-id": sourceSessionId,
      }
      const detail = await withBoundedFetch({
        url: root,
        init: { headers },
        consume: async (response) => {
          await expectSuccess(response)
          return (await response.json()) as Record<string, unknown>
        },
      })
      const bundle = await withBoundedFetch({
        url: `${root}/bundle`,
        init: { headers },
        consume: async (response) => {
          await expectSuccess(response)
          return readBoundedResponseBytes(response, versionBundleMaxDownloadBytes())
        },
      })
      return {
        catalog: AlgorithmVersionPackage.CatalogMetadata.parse(detail.algorithm ?? detail.catalog ?? detail),
        bundle,
      }
    },
  }
}

async function deliver(item: OutboxItem, transport: Transport): Promise<void> {
  if (item.kind === "version") {
    await transport.publishVersion({
      publication: item.publication,
      bundle: Uint8Array.from(Buffer.from(item.archiveBase64, "base64")),
    })
    return
  }
  await transport.publishBacktest({
    publication: item.publication,
    evidence: item.evidenceBase64 ? Uint8Array.from(Buffer.from(item.evidenceBase64, "base64")) : undefined,
  })
}

async function enqueueAndDeliver(item: OutboxItem): Promise<PublishStatus> {
  const syncMode = mode()
  if (syncMode === "off") return "disabled"
  const persisted = await persistOutbox(item)
  let current = persisted
  try {
    current = await currentVersionOutboxItem(persisted)
    await deliver(current.item, testTransport ?? defaultTransport())
    await fs.rm(current.file, { force: true })
    return "published"
  } catch (error) {
    throw new PublishError("Required central publication failed", current.file, { cause: error })
  }
}

export async function publishAlgorithmVersion(
  algorithm: Algorithm.Info,
  options: { sourceSessionId?: string } = {},
): Promise<PublishStatus> {
  if (mode() === "off") return "disabled"
  const packaged = await AlgorithmVersionPackage.build({
    algorithmId: algorithm.algorithmId,
    version: algorithm.version,
  })
  const algorithmPublication: VersionPublication["algorithm"] = {
    algorithmId: algorithm.algorithmId,
    name: algorithm.name,
    version: algorithm.version,
    status: algorithm.status,
    language: algorithm.language,
    description: algorithm.description,
    brokerKind: algorithm.brokerKind,
    targetBrokerage: algorithm.targetBrokerage,
    timeCreated: algorithm.time_created,
    timeUpdated: algorithm.time_updated,
  }
  const packagePublication: VersionPublication["package"] = {
    payloadHash: packaged.manifest.payloadHash,
    archiveSha256: packaged.archiveSha256,
    bytes: packaged.archive.length,
    files: packaged.manifest.files,
  }
  const publicationIdentity = sha256(stableStringify({ algorithm: algorithmPublication, package: packagePublication }))
  const publication: VersionPublication = {
    schema: "finny.algorithm_version_publication",
    schemaVersion: 1,
    idempotencyKey: `algorithm-version:${publicationIdentity}`,
    sourceSessionId: resolvedSourceSessionId(options.sourceSessionId),
    algorithm: algorithmPublication,
    package: packagePublication,
  }
  return enqueueAndDeliver({
    kind: "version",
    publication: VersionPublication.parse(publication),
    archiveBase64: Buffer.from(packaged.archive).toString("base64"),
    outboxRevision: nextOutboxRevision(),
  })
}

function summaryPublication(manifest: BacktestStore.Manifest, sourceSessionId?: string): BacktestPublication {
  const publication: BacktestPublication = {
    schema: "finny.backtest_publication",
    schemaVersion: 1,
    idempotencyKey: `${manifest.algorithmId}:v${manifest.algorithmVersion}:backtest:${manifest.id}:summary`,
    sourceSessionId: resolvedSourceSessionId(sourceSessionId),
    algorithmId: manifest.algorithmId,
    algorithmVersion: manifest.algorithmVersion,
    run: { runId: manifest.id, status: "completed", completedAt: manifest.timestamp, evidenceAvailable: false },
    parameters: {
      ...manifest.params,
      symbol: manifest.symbol,
      source: manifest.source,
      assumptions: manifest.assumptions,
    },
    metrics: { ...manifest.results, benchmark: manifest.benchmark, alpha: manifest.alpha },
  }
  return BacktestPublication.parse(publication)
}

export async function publishBacktestSummary(
  manifest: BacktestStore.Manifest,
  options: { sourceSessionId?: string } = {},
): Promise<PublishStatus> {
  if (mode() === "off") return "disabled"
  return enqueueAndDeliver({ kind: "backtest", publication: summaryPublication(manifest, options.sourceSessionId) })
}

const REQUIRED_STRICT_EVIDENCE = ["run.json", "artifact-manifest.json"] as const
const INVALID_EVIDENCE_PATH_PARTS = new Set(["", ".", ".."])
const SAFE_EVIDENCE_PATH_CHECKS: ReadonlyArray<(relative: string) => boolean> = [
  (relative) => relative.length > 0,
  (relative) => !relative.includes("\\"),
  (relative) => !path.posix.isAbsolute(relative),
  (relative) => path.posix.normalize(relative) === relative,
  (relative) => !relative.split("/").some((part) => INVALID_EVIDENCE_PATH_PARTS.has(part)),
]

function assertSafeEvidencePath(relative: string): void {
  const safe = SAFE_EVIDENCE_PATH_CHECKS.every((check) => check(relative))
  if (!safe) throw new PreflightError(`Unsafe strict-run evidence path: ${relative}`)
}

function strictEvidenceLimits(): StrictEvidenceLimits {
  const totalBytes = positiveIntegerEnv("FINNY_BACKTEST_EVIDENCE_MAX_BYTES", STRICT_EVIDENCE_DEFAULT_TOTAL_BYTES)
  return {
    totalBytes,
    entryBytes: Math.min(STRICT_EVIDENCE_MAX_ENTRY_BYTES, totalBytes),
    maxEntries: STRICT_EVIDENCE_MAX_ENTRIES,
  }
}

function addStrictEvidenceFile(scan: StrictEvidenceScan, entry: StrictEvidenceEntry): void {
  if (scan.entries.length >= scan.limits.maxEntries) {
    throw new PreflightError(`Strict-run evidence exceeds ${scan.limits.maxEntries} entries`)
  }
  if (entry.bytes > scan.limits.entryBytes) {
    throw new PreflightError(`Strict-run evidence entry is too large: ${entry.relative}`)
  }
  const nextTotal = scan.totalBytes + entry.bytes
  if (nextTotal > scan.limits.totalBytes) throw new PreflightError("Strict-run evidence exceeds maximum total size")
  scan.totalBytes = nextTotal
  scan.entries.push(entry)
}

async function visitStrictEvidenceEntry(input: {
  scan: StrictEvidenceScan
  parent: string
  entry: Dirent
}): Promise<void> {
  const relative = input.parent ? path.posix.join(input.parent, input.entry.name) : input.entry.name
  assertSafeEvidencePath(relative)
  const file = path.join(input.scan.root, relative)
  const stat = await fs.lstat(file)
  if (stat.isSymbolicLink()) throw new PreflightError(`Strict-run evidence may not contain a symlink: ${relative}`)
  if (stat.isDirectory()) {
    await visitStrictEvidenceDirectory(input.scan, relative)
    return
  }
  if (!stat.isFile()) throw new PreflightError(`Unsupported strict-run evidence entry: ${relative}`)
  addStrictEvidenceFile(input.scan, { relative, file, bytes: stat.size })
}

async function visitStrictEvidenceDirectory(scan: StrictEvidenceScan, relative = ""): Promise<void> {
  const entries = await fs.readdir(path.join(scan.root, relative), { withFileTypes: true })
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of sortedEntries) await visitStrictEvidenceEntry({ scan, parent: relative, entry })
}

async function scanStrictEvidence(input: {
  root: string
  limits: StrictEvidenceLimits
}): Promise<StrictEvidenceEntry[]> {
  const scan: StrictEvidenceScan = { ...input, entries: [], totalBytes: 0 }
  try {
    await visitStrictEvidenceDirectory(scan)
    return scan.entries
  } catch (error) {
    if (error instanceof PreflightError) throw error
    throw new PreflightError("Strict-run evidence preflight failed", { cause: error })
  }
}

function assertRequiredStrictEvidence(entries: StrictEvidenceEntry[]): void {
  for (const required of REQUIRED_STRICT_EVIDENCE) {
    const present = entries.some((entry) => entry.relative === required && entry.bytes > 0)
    if (!present) throw new PreflightError(`Strict-run evidence is missing required file: ${required}`)
  }
}

async function readStrictEvidenceFiles(entries: StrictEvidenceEntry[]): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  for (const entry of entries) {
    const bytes = new Uint8Array(await fs.readFile(entry.file))
    if (bytes.length !== entry.bytes) {
      throw new PreflightError(`Strict-run evidence entry changed while reading: ${entry.relative}`)
    }
    files.set(entry.relative, bytes)
  }
  return files
}

async function packageStrictEvidence(input: {
  entries: StrictEvidenceEntry[]
  totalLimit: number
}): Promise<Uint8Array> {
  try {
    const files = await readStrictEvidenceFiles(input.entries)
    const archive = await AlgorithmVersionPackage.createArchive(files)
    if (archive.length > input.totalLimit) {
      throw new PreflightError("Strict-run evidence archive exceeds maximum upload size")
    }
    return archive
  } catch (error) {
    if (error instanceof PreflightError) throw error
    throw new PreflightError("Strict-run evidence packaging failed", { cause: error })
  }
}

async function strictEvidenceArchive(input: {
  directory: string
  manifest: BacktestStore.Manifest
}): Promise<Uint8Array> {
  const limits = strictEvidenceLimits()
  const entries = await scanStrictEvidence({ root: input.directory, limits })
  assertRequiredStrictEvidence(entries)
  await assertStrictEvidenceIntegrity(input)
  return packageStrictEvidence({ entries, totalLimit: limits.totalBytes })
}

async function assertStrictEvidenceIntegrity(input: {
  directory: string
  manifest: BacktestStore.Manifest
}): Promise<void> {
  const verified = await verifyStrictRunDir(input.directory)
  if (!verified.ok || !verified.run) {
    const detail = verified.errors.slice(0, 10).join("; ") || "unknown integrity failure"
    throw new PreflightError(`Strict-run evidence integrity verification failed: ${detail}`)
  }

  const identity = verified.run.identity
  const mismatches = [
    verified.run.runId === input.manifest.id ? undefined : "runId",
    identity.algorithmId === input.manifest.algorithmId ? undefined : "algorithmId",
    identity.algorithmVersion === input.manifest.algorithmVersion ? undefined : "algorithmVersion",
  ].filter((field): field is string => field !== undefined)
  if (mismatches.length > 0) {
    throw new PreflightError(`Strict-run evidence does not match the backtest manifest: ${mismatches.join(", ")}`)
  }
}

export async function publishStrictRun(input: {
  manifest: BacktestStore.Manifest
  dir: string
  execution?: Record<string, unknown>
  broker?: Record<string, unknown>
  sourceSessionId?: string
}): Promise<PublishStatus> {
  if (mode() === "off") return "disabled"
  const evidence = await strictEvidenceArchive({ directory: input.dir, manifest: input.manifest })
  const base = summaryPublication(input.manifest, input.sourceSessionId)
  const publication: BacktestPublication = BacktestPublication.parse({
    ...base,
    idempotencyKey: `${input.manifest.algorithmId}:v${input.manifest.algorithmVersion}:backtest:${input.manifest.id}:strict:${sha256(evidence)}`,
    run: { ...base.run, evidenceAvailable: true },
    execution: input.execution,
    broker: input.broker,
  })
  return enqueueAndDeliver({ kind: "backtest", publication, evidenceBase64: Buffer.from(evidence).toString("base64") })
}

async function readQueuedOutboxItem(name: string): Promise<QueuedOutboxItem | undefined> {
  const file = path.join(outboxDir(), name)
  try {
    const item = OutboxItem.parse(JSON.parse(await fs.readFile(file, "utf8")))
    return { file, item }
  } catch {
    return undefined
  }
}

async function readOutboxQueue(names: string[]): Promise<{ queued: QueuedOutboxItem[]; failed: number }> {
  const queued: QueuedOutboxItem[] = []
  let failed = 0
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const item = await readQueuedOutboxItem(name)
    if (item) queued.push(item)
    else failed++
  }
  return { queued, failed }
}

function outboxRetryOrder(left: QueuedOutboxItem, right: QueuedOutboxItem): number {
  if (left.item.kind !== right.item.kind) return left.item.kind === "version" ? -1 : 1
  return left.item.publication.idempotencyKey.localeCompare(right.item.publication.idempotencyKey)
}

async function collapseSupersededVersions(
  queued: QueuedOutboxItem[],
): Promise<{ queued: QueuedOutboxItem[]; failed: number }> {
  const retained: QueuedOutboxItem[] = []
  const groups = new Map<string, QueuedOutboxItem[]>()
  for (const item of queued) {
    if (item.item.kind !== "version") {
      retained.push(item)
      continue
    }
    const key = stableStringify({
      algorithmId: item.item.publication.algorithm.algorithmId,
      version: item.item.publication.algorithm.version,
      payloadHash: item.item.publication.package.payloadHash,
      archiveSha256: item.item.publication.package.archiveSha256,
    })
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }

  let failed = 0
  for (const group of groups.values()) {
    const current = group.slice(1).reduce(newerVersionPublication, group[0])
    try {
      for (const stale of group) {
        if (stale.file === current.file) continue
        await fs.rm(stale.file, { force: true })
      }
      retained.push(current)
    } catch {
      failed++
    }
  }
  return { queued: retained, failed }
}

async function retryQueuedOutboxItem(input: { queued: QueuedOutboxItem; transport: Transport }): Promise<boolean> {
  try {
    await deliver(input.queued.item, input.transport)
    await fs.rm(input.queued.file, { force: true })
    return true
  } catch {
    return false
  }
}

async function outboxEntryNames(): Promise<string[]> {
  return fs.readdir(outboxDir()).catch((error: any) => {
    if (error?.code === "ENOENT") return []
    throw error
  })
}

export async function retryOutbox(): Promise<{ published: number; failed: number }> {
  if (mode() === "off") return { published: 0, failed: 0 }
  const result = await readOutboxQueue(await outboxEntryNames())
  const collapsed = await collapseSupersededVersions(result.queued)
  result.failed += collapsed.failed
  collapsed.queued.sort(outboxRetryOrder)
  if (collapsed.queued.length === 0) return { published: 0, failed: result.failed }
  const transport = testTransport ?? defaultTransport()
  let published = 0
  for (const queued of collapsed.queued) {
    if (await retryQueuedOutboxItem({ queued, transport })) published++
    else result.failed++
  }
  return { published, failed: result.failed }
}

function runScheduledOutboxRetry(): void {
  if (outboxRetryInFlight) return
  outboxRetryInFlight = retryOutbox()
    .then((result) => {
      if (result.published > 0 || result.failed > 0) log.info("outbox replay completed", result)
    })
    .catch((error) => log.warn("outbox replay failed", { error }))
    .finally(() => {
      outboxRetryInFlight = undefined
    })
}

export function startOutboxReplay(): void {
  if (outboxRetryTimer || mode() === "off") return
  runScheduledOutboxRetry()
  outboxRetryTimer = setInterval(
    runScheduledOutboxRetry,
    positiveIntegerEnv("FINNY_PLATFORM_OUTBOX_RETRY_INTERVAL_MS", DEFAULT_OUTBOX_RETRY_INTERVAL_MS),
  )
  outboxRetryTimer.unref?.()
}

export function stopOutboxReplay(): void {
  if (outboxRetryTimer) clearInterval(outboxRetryTimer)
  outboxRetryTimer = undefined
}

export async function pendingOutbox(): Promise<string[]> {
  return (await fs.readdir(outboxDir()).catch(() => []))
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(outboxDir(), entry))
}

const SAFE_MATERIALIZE_ID_CHECKS: ReadonlyArray<(value: string) => boolean> = [
  (value) => value.length > 0,
  (value) => !/[\\/\0]/.test(value),
]

function assertMaterializeRequest(input: MaterializeVersionRequest): void {
  const safeAlgorithmId = SAFE_MATERIALIZE_ID_CHECKS.every((check) => check(input.algorithmId))
  if (!safeAlgorithmId) throw new Error("algorithmId must be a safe path segment")
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("version must be a positive integer")
}

async function downloadCentralVersion(input: {
  transport: Transport
  request: MaterializeVersionRequest
}): Promise<DownloadedVersion> {
  if (!input.transport.downloadVersion) {
    throw new Error("Central transport does not support algorithm version downloads")
  }
  return input.transport.downloadVersion(input.request)
}

function assertDownloadedIdentity(input: { request: MaterializeVersionRequest; downloaded: DownloadedVersion }): void {
  const sameAlgorithm = input.downloaded.catalog.algorithmId === input.request.algorithmId
  const sameVersion = input.downloaded.catalog.version === input.request.version
  if (!sameAlgorithm || !sameVersion)
    throw new Error("Downloaded catalog identity does not match the requested version")
}

export async function materializeVersion(input: MaterializeVersionRequest) {
  assertMaterializeRequest(input)
  const transport = testTransport ?? defaultTransport()
  const downloaded = await downloadCentralVersion({ transport, request: input })
  assertDownloadedIdentity({ request: input, downloaded })
  return AlgorithmVersionPackage.materialize({ archive: downloaded.bundle, catalog: downloaded.catalog })
}

export function _setTransportForTests(transport?: Transport): void {
  testTransport = transport
}

export * as CentralSync from "./central-sync"
