import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import type { Algorithm } from "."
import type { BacktestStore } from "@/backtest/store"
import { AlgorithmVersionPackage, type CatalogMetadata } from "./version-package"

export type Mode = "off" | "required"
export type PublishStatus = "disabled" | "published"

const DEFAULT_HTTP_TIMEOUT_MS = 30_000
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

async function withBoundedFetch<T>(
  input: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const timeoutMs = httpTimeoutMs()
  const controller = new AbortController()
  let timedOut = false
  const relayAbort = () => controller.abort(init.signal?.reason)
  if (init.signal?.aborted) relayAbort()
  else init.signal?.addEventListener("abort", relayAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new TransportTimeoutError(timeoutMs))
  }, timeoutMs)
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? new CentralSyncError("Finny Platform request aborted")),
      { once: true },
    )
  })
  try {
    return await Promise.race([
      (async () => consume(await fetch(input, { ...init, signal: controller.signal })))(),
      aborted,
    ])
  } catch (error) {
    if (timedOut) throw new TransportTimeoutError(timeoutMs, { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener("abort", relayAbort)
  }
}

function platformConfig() {
  const baseUrl = (process.env.FINNY_PLATFORM_URL?.trim() || process.env.OMNIGENT_POLICY_URL?.trim())?.replace(
    /\/+$/,
    "",
  )
  const explicitToken = process.env.FINNY_PLATFORM_ACCESS_TOKEN?.trim()
  const omnigentAuth = process.env.OMNIGENT_POLICY_AUTH?.trim()
  const bearer = omnigentAuth ? /^Bearer ([^\s]+)$/.exec(omnigentAuth) : undefined
  const token = explicitToken || bearer?.[1]
  if (!baseUrl) {
    throw new Error("FINNY_PLATFORM_URL or OMNIGENT_POLICY_URL is required when central sync is enabled")
  }
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
      await withBoundedFetch(
        `${baseUrl}/api/finny/algorithms/${encodeURIComponent(publication.algorithm.algorithmId)}/versions`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        },
        expectSuccess,
      )
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
      await withBoundedFetch(
        `${baseUrl}/api/finny/algorithms/${encodeURIComponent(publication.algorithmId)}/versions/${publication.algorithmVersion}/backtests`,
        { method: "POST", headers: { authorization: `Bearer ${token}` }, body },
        expectSuccess,
      )
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
      const detail = await withBoundedFetch(root, { headers }, async (response) => {
        await expectSuccess(response)
        return (await response.json()) as Record<string, unknown>
      })
      const bundle = await withBoundedFetch(`${root}/bundle`, { headers }, async (response) => {
        await expectSuccess(response)
        return new Uint8Array(await response.arrayBuffer())
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
  try {
    await deliver(persisted.item, testTransport ?? defaultTransport())
    await fs.rm(persisted.file, { force: true })
    return "published"
  } catch (error) {
    throw new PublishError("Required central publication failed", persisted.file, { cause: error })
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
  const publication: VersionPublication = {
    schema: "finny.algorithm_version_publication",
    schemaVersion: 1,
    idempotencyKey: `${algorithm.algorithmId}:v${algorithm.version}:${packaged.manifest.payloadHash}`,
    sourceSessionId: resolvedSourceSessionId(options.sourceSessionId),
    algorithm: {
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
    },
    package: {
      payloadHash: packaged.manifest.payloadHash,
      archiveSha256: packaged.archiveSha256,
      bytes: packaged.archive.length,
      files: packaged.manifest.files,
    },
  }
  return enqueueAndDeliver({
    kind: "version",
    publication: VersionPublication.parse(publication),
    archiveBase64: Buffer.from(packaged.archive).toString("base64"),
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

async function strictEvidenceArchive(dir: string): Promise<Uint8Array> {
  const totalLimit = positiveIntegerEnv("FINNY_BACKTEST_EVIDENCE_MAX_BYTES", STRICT_EVIDENCE_DEFAULT_TOTAL_BYTES)
  const entryLimit = Math.min(STRICT_EVIDENCE_MAX_ENTRY_BYTES, totalLimit)
  const pending: Array<{ relative: string; file: string; bytes: number }> = []
  let total = 0

  function assertSafeRelative(relative: string): void {
    if (
      !relative ||
      relative.includes("\\") ||
      path.posix.isAbsolute(relative) ||
      path.posix.normalize(relative) !== relative ||
      relative.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new PreflightError(`Unsafe strict-run evidence path: ${relative}`)
    }
  }

  async function visit(relative = ""): Promise<void> {
    const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const next = relative ? path.posix.join(relative, entry.name) : entry.name
      assertSafeRelative(next)
      const file = path.join(dir, next)
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) throw new PreflightError(`Strict-run evidence may not contain a symlink: ${next}`)
      if (stat.isDirectory()) {
        await visit(next)
        continue
      }
      if (!stat.isFile()) throw new PreflightError(`Unsupported strict-run evidence entry: ${next}`)
      if (pending.length >= STRICT_EVIDENCE_MAX_ENTRIES) {
        throw new PreflightError(`Strict-run evidence exceeds ${STRICT_EVIDENCE_MAX_ENTRIES} entries`)
      }
      if (stat.size > entryLimit) throw new PreflightError(`Strict-run evidence entry is too large: ${next}`)
      total += stat.size
      if (total > totalLimit) throw new PreflightError("Strict-run evidence exceeds maximum total size")
      pending.push({ relative: next, file, bytes: stat.size })
    }
  }

  try {
    await visit()
  } catch (error) {
    if (error instanceof PreflightError) throw error
    throw new PreflightError("Strict-run evidence preflight failed", { cause: error })
  }

  for (const required of ["run.json", "artifact-manifest.json"]) {
    const entry = pending.find((candidate) => candidate.relative === required)
    if (!entry || entry.bytes === 0)
      throw new PreflightError(`Strict-run evidence is missing required file: ${required}`)
  }

  const files = new Map<string, Uint8Array>()
  try {
    for (const entry of pending) {
      const bytes = new Uint8Array(await fs.readFile(entry.file))
      if (bytes.length !== entry.bytes) {
        throw new PreflightError(`Strict-run evidence entry changed while reading: ${entry.relative}`)
      }
      files.set(entry.relative, bytes)
    }
    const archive = await AlgorithmVersionPackage.createArchive(files)
    if (archive.length > totalLimit) {
      throw new PreflightError("Strict-run evidence archive exceeds maximum upload size")
    }
    return archive
  } catch (error) {
    if (error instanceof PreflightError) throw error
    throw new PreflightError("Strict-run evidence packaging failed", { cause: error })
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
  const evidence = await strictEvidenceArchive(input.dir)
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

export async function retryOutbox(): Promise<{ published: number; failed: number }> {
  if (mode() === "off") return { published: 0, failed: 0 }
  const transport = testTransport ?? defaultTransport()
  const entries = await fs.readdir(outboxDir()).catch((error: any) => {
    if (error?.code === "ENOENT") return []
    throw error
  })
  const queued: Array<{ file: string; item: OutboxItem }> = []
  let failed = 0
  for (const name of entries.filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(outboxDir(), name)
    try {
      const item = OutboxItem.parse(JSON.parse(await fs.readFile(file, "utf8")))
      queued.push({ file, item })
    } catch {
      failed++
    }
  }
  queued.sort((left, right) => {
    if (left.item.kind !== right.item.kind) return left.item.kind === "version" ? -1 : 1
    return left.item.publication.idempotencyKey.localeCompare(right.item.publication.idempotencyKey)
  })
  let published = 0
  for (const queuedItem of queued) {
    try {
      await deliver(queuedItem.item, transport)
      await fs.rm(queuedItem.file, { force: true })
      published++
    } catch {
      failed++
    }
  }
  return { published, failed }
}

export async function pendingOutbox(): Promise<string[]> {
  return (await fs.readdir(outboxDir()).catch(() => []))
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(outboxDir(), entry))
}

export async function materializeVersion(input: { algorithmId: string; version: number }) {
  if (!input.algorithmId || /[\\/\0]/.test(input.algorithmId))
    throw new Error("algorithmId must be a safe path segment")
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("version must be a positive integer")
  const transport = testTransport ?? defaultTransport()
  if (!transport.downloadVersion) throw new Error("Central transport does not support algorithm version downloads")
  const downloaded = await transport.downloadVersion(input)
  if (downloaded.catalog.algorithmId !== input.algorithmId || downloaded.catalog.version !== input.version) {
    throw new Error("Downloaded catalog identity does not match the requested version")
  }
  return AlgorithmVersionPackage.materialize({ archive: downloaded.bundle, catalog: downloaded.catalog })
}

export function _setTransportForTests(transport?: Transport): void {
  testTransport = transport
}

export * as CentralSync from "./central-sync"
