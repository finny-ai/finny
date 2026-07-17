import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import { normalizeInterval, normalizeSymbol } from "./request-identity"

const REQUEST_ID_RE = /^[A-Za-z0-9._-]+$/
const CURRENT_SPEC_FILE = "current.json"
const AMENDMENTS_FILE = "amendments.jsonl"
const LEGACY_REQUEST_FILE = "request.json"
const INITIAL_REQUEST_REASON = "initial request identity"
const AMENDMENT_REASON = "validated request identity amendment"
const LEGACY_MIGRATION_REASON = "one-time migration from legacy workspace request.json"

export type RequestApprovalState = "approved" | "pending" | "rejected" | "legacy"

export interface RequestApproval {
  actor: "user" | "runtime" | "migration"
  reason: string
  state: RequestApprovalState
  at: string
}

export interface RequestSpec {
  schema_version: 1
  request_id: string
  request_version: number
  content_hash: string
  requested_symbol?: string
  requested_symbols?: string[]
  requested_asset_class?: "equity" | "crypto"
  requested_interval?: string
  requested_start?: string
  requested_end?: string
  requested_algorithm_name?: string
  execution_assumptions: Record<string, string | number | boolean>
  evidence_requirements: {
    data_extractor: boolean
    news_agent: boolean
    fail_closed_on_identity_mismatch: boolean
  }
  user_approvals: RequestApproval[]
  created_at: string
  updated_at: string
}

export interface RequestSpecAmendment {
  request_id: string
  from_version: number | null
  to_version: number
  previous_hash: string | null
  content_hash: string
  actor: RequestApproval["actor"]
  reason: string
  approval_state: RequestApprovalState
  at: string
}

export type RequestSpecIdentity = Pick<
  RequestSpec,
  | "requested_symbol"
  | "requested_symbols"
  | "requested_asset_class"
  | "requested_interval"
  | "requested_start"
  | "requested_end"
  | "requested_algorithm_name"
>

export interface CommitRequestSpecInput {
  requestID: string
  identity: RequestSpecIdentity
  preserveExisting?: boolean
  actor?: RequestApproval["actor"]
  reason?: string
  approvalState?: RequestApprovalState
  now?: Date
}

interface CommitMetadata {
  actor: RequestApproval["actor"]
  reason: string
  approvalState: RequestApprovalState
  at: string
}

function requestSpecsRoot(): string {
  return path.join(path.dirname(finnyArtifactPath("algos")), "request-specs")
}

function requestDir(input: { requestID: string }): string {
  if (!REQUEST_ID_RE.test(input.requestID)) throw new Error(`invalid request id: ${JSON.stringify(input.requestID)}`)
  return path.join(requestSpecsRoot(), input.requestID)
}

function requestBindingPath(input: { sessionID: string }): string {
  if (!REQUEST_ID_RE.test(input.sessionID)) throw new Error(`invalid session id: ${JSON.stringify(input.sessionID)}`)
  return path.join(requestSpecsRoot(), ".session-bindings", input.sessionID)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]),
  )
}

function hashSpec(spec: Omit<RequestSpec, "content_hash"> | RequestSpec): string {
  const { content_hash: _ignored, ...body } = spec as RequestSpec
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(body)))
    .digest("hex")}`
}

function normalizeIdentity(identity: RequestSpecIdentity): RequestSpecIdentity {
  const symbols = identity.requested_symbols
    ?.map((symbol) => normalizeSymbol(symbol))
    .filter((symbol): symbol is string => Boolean(symbol))
  const symbol = symbols?.length ? undefined : normalizeSymbol(identity.requested_symbol)
  const assetClass = identity.requested_asset_class
  return {
    requested_symbol: symbol,
    requested_symbols: symbols?.length ? [...new Set(symbols)] : undefined,
    requested_asset_class: assetClass,
    requested_interval: normalizeInterval(identity.requested_interval),
    requested_start: identity.requested_start,
    requested_end: identity.requested_end,
    requested_algorithm_name: identity.requested_algorithm_name?.trim() || undefined,
  }
}

function semanticIdentity(spec: RequestSpec | RequestSpecIdentity): string {
  return JSON.stringify(stableValue(normalizeIdentity(spec)))
}

async function atomicWrite(input: { file: string; contents: string }): Promise<void> {
  const temporary = `${input.file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, input.contents, { encoding: "utf8", mode: 0o600 })
  await fs.rename(temporary, input.file)
}

export async function readRequestSpec(input: { requestID: string }): Promise<RequestSpec | undefined> {
  const { requestID } = input
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(requestDir({ requestID }), CURRENT_SPEC_FILE), "utf8"),
    ) as RequestSpec
    if (parsed.request_id !== requestID || parsed.content_hash !== hashSpec(parsed)) {
      throw new Error(`request spec integrity check failed for ${requestID}`)
    }
    return parsed
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

export async function bindSessionRequest(input: { sessionID: string; requestID: string }): Promise<void> {
  const { sessionID, requestID } = input
  requestDir({ requestID })
  const file = requestBindingPath({ sessionID })
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await atomicWrite({ file, contents: `${requestID}\n` })
}

export async function readRequestSpecForSession(input: { sessionID: string }): Promise<RequestSpec | undefined> {
  let requestID = input.sessionID
  try {
    const bound = (await fs.readFile(requestBindingPath({ sessionID: input.sessionID }), "utf8")).trim()
    if (bound) requestID = bound
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }
  return readRequestSpec({ requestID })
}

export async function readRequestSpecHistory(input: { requestID: string }): Promise<RequestSpecAmendment[]> {
  const { requestID } = input
  try {
    const raw = await fs.readFile(path.join(requestDir({ requestID }), AMENDMENTS_FILE), "utf8")
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RequestSpecAmendment)
  } catch (error: any) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === "string") : undefined
}

function optionalAssetClass(value: unknown): RequestSpecIdentity["requested_asset_class"] {
  return value === "equity" || value === "crypto" ? value : undefined
}

function legacyIdentity(value: unknown): RequestSpecIdentity | undefined {
  if (!value || typeof value !== "object") return undefined
  const parsed = value as Record<string, unknown>
  return {
    requested_symbol: optionalString(parsed.requested_symbol),
    requested_symbols: optionalStringArray(parsed.requested_symbols),
    requested_asset_class: optionalAssetClass(parsed.requested_asset_class),
    requested_interval: optionalString(parsed.requested_interval),
    requested_start: optionalString(parsed.requested_start),
    requested_end: optionalString(parsed.requested_end),
    requested_algorithm_name: optionalString(parsed.requested_algorithm_name),
  }
}

async function readLegacyWorkspaceIdentity(input: { workspaceDir: string }): Promise<RequestSpecIdentity | undefined> {
  try {
    return legacyIdentity(JSON.parse(await fs.readFile(path.join(input.workspaceDir, LEGACY_REQUEST_FILE), "utf8")))
  } catch {
    return undefined
  }
}

/** One-time compatibility bridge for sessions created before runtime ownership. */
export async function migrateLegacyWorkspaceRequest(input: {
  requestID: string
  workspaceDir: string
}): Promise<RequestSpec | undefined> {
  const { requestID, workspaceDir } = input
  const current = await readRequestSpec({ requestID })
  if (current) return current
  const identity = await readLegacyWorkspaceIdentity({ workspaceDir })
  if (!identity) return undefined
  return commitRequestSpec({
    requestID,
    identity,
    actor: "migration",
    reason: LEGACY_MIGRATION_REASON,
    approvalState: "legacy",
  })
}

function mergeIdentity(
  current: RequestSpec | undefined,
  incoming: RequestSpecIdentity,
  preserveExisting = false,
): RequestSpecIdentity {
  const replacesWithUniverse = !preserveExisting && incoming.requested_symbols !== undefined
  const replacesWithSingle = !preserveExisting && incoming.requested_symbol !== undefined
  return normalizeIdentity({
    requested_symbol: replacesWithUniverse
      ? undefined
      : mergeValue(current?.requested_symbol, incoming.requested_symbol, preserveExisting),
    requested_symbols: replacesWithSingle
      ? undefined
      : mergeValue(current?.requested_symbols, incoming.requested_symbols, preserveExisting),
    requested_asset_class: mergeValue(current?.requested_asset_class, incoming.requested_asset_class, preserveExisting),
    requested_interval: mergeValue(current?.requested_interval, incoming.requested_interval, preserveExisting),
    requested_start: mergeValue(current?.requested_start, incoming.requested_start, preserveExisting),
    requested_end: mergeValue(current?.requested_end, incoming.requested_end, preserveExisting),
    requested_algorithm_name: incoming.requested_algorithm_name ?? current?.requested_algorithm_name,
  })
}

function mergeValue<T>(current: T | undefined, incoming: T | undefined, preserveExisting: boolean): T | undefined {
  return preserveExisting ? (current ?? incoming) : (incoming ?? current)
}

function commitMetadata(input: CommitRequestSpecInput, current: RequestSpec | undefined): CommitMetadata {
  return {
    actor: input.actor ?? "runtime",
    reason: input.reason ?? (current ? AMENDMENT_REASON : INITIAL_REQUEST_REASON),
    approvalState: input.approvalState ?? "approved",
    at: (input.now ?? new Date()).toISOString(),
  }
}

function buildRequestSpec(input: {
  requestID: string
  identity: RequestSpecIdentity
  current: RequestSpec | undefined
  metadata: CommitMetadata
}): RequestSpec {
  const { requestID, identity, current, metadata } = input
  const approval: RequestApproval = {
    actor: metadata.actor,
    reason: metadata.reason,
    state: metadata.approvalState,
    at: metadata.at,
  }
  const body: Omit<RequestSpec, "content_hash"> = {
    schema_version: 1,
    request_id: requestID,
    request_version: (current?.request_version ?? 0) + 1,
    ...identity,
    execution_assumptions: current?.execution_assumptions ?? {},
    evidence_requirements: current?.evidence_requirements ?? {
      data_extractor: true,
      news_agent: true,
      fail_closed_on_identity_mismatch: true,
    },
    user_approvals: [...(current?.user_approvals ?? []), approval],
    created_at: current?.created_at ?? metadata.at,
    updated_at: metadata.at,
  }
  return { ...body, content_hash: hashSpec(body) }
}

function amendmentEvent(input: {
  spec: RequestSpec
  current: RequestSpec | undefined
  metadata: CommitMetadata
}): RequestSpecAmendment {
  const { spec, current, metadata } = input
  return {
    request_id: spec.request_id,
    from_version: current?.request_version ?? null,
    to_version: spec.request_version,
    previous_hash: current?.content_hash ?? null,
    content_hash: spec.content_hash,
    actor: metadata.actor,
    reason: metadata.reason,
    approval_state: metadata.approvalState,
    at: metadata.at,
  }
}

async function persistRequestSpec(input: {
  spec: RequestSpec
  current: RequestSpec | undefined
  metadata: CommitMetadata
}): Promise<void> {
  const { spec, current, metadata } = input
  const dir = requestDir({ requestID: spec.request_id })
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await atomicWrite({
    file: path.join(dir, `v${String(spec.request_version).padStart(6, "0")}.json`),
    contents: `${JSON.stringify(spec, null, 2)}\n`,
  })
  await atomicWrite({ file: path.join(dir, CURRENT_SPEC_FILE), contents: `${JSON.stringify(spec, null, 2)}\n` })
  await fs.appendFile(
    path.join(dir, AMENDMENTS_FILE),
    `${JSON.stringify(amendmentEvent({ spec, current, metadata }))}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  )
}

export async function commitRequestSpec(input: CommitRequestSpecInput): Promise<RequestSpec> {
  const current = await readRequestSpec({ requestID: input.requestID })
  const merged = mergeIdentity(current, normalizeIdentity(input.identity), input.preserveExisting)
  if (current && semanticIdentity(current) === semanticIdentity(merged)) {
    await bindSessionRequest({ sessionID: input.requestID, requestID: input.requestID })
    return current
  }

  const metadata = commitMetadata(input, current)
  const spec = buildRequestSpec({ requestID: input.requestID, identity: merged, current, metadata })
  await persistRequestSpec({ spec, current, metadata })
  await bindSessionRequest({ sessionID: input.requestID, requestID: input.requestID })
  return spec
}

export function requestSpecProjection(spec: RequestSpec): Record<string, unknown> {
  return {
    requested_symbol: spec.requested_symbol,
    requested_symbols: spec.requested_symbols,
    requested_interval: spec.requested_interval,
    requested_asset_class: spec.requested_asset_class,
    requested_algorithm_name: spec.requested_algorithm_name,
    requested_start: spec.requested_start,
    requested_end: spec.requested_end,
    request_id: spec.request_id,
    request_version: spec.request_version,
    request_content_hash: spec.content_hash,
    authoritative: false,
    runtime_owned: true,
    updated: spec.updated_at,
  }
}

export async function writeRequestSpecProjection(input: { workspaceDir: string; spec: RequestSpec }): Promise<void> {
  const file = path.join(input.workspaceDir, LEGACY_REQUEST_FILE)
  await fs.chmod(file, 0o600).catch(() => undefined)
  await atomicWrite({ file, contents: `${JSON.stringify(requestSpecProjection(input.spec), null, 2)}\n` })
  await fs.chmod(file, 0o444)
}

export async function requestProjectionMatches(input: { workspaceDir: string; spec: RequestSpec }): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(input.workspaceDir, LEGACY_REQUEST_FILE), "utf8"))
    return (
      parsed.request_id === input.spec.request_id &&
      parsed.request_version === input.spec.request_version &&
      parsed.request_content_hash === input.spec.content_hash &&
      JSON.stringify(stableValue(parsed)) === JSON.stringify(stableValue(requestSpecProjection(input.spec)))
    )
  } catch {
    return false
  }
}

/** Hard shell boundary: model-issued commands may not address the runtime store. */
export function assertNoRuntimeRequestSpecPath(input: { command: string }): void {
  const normalized = input.command
    .toLowerCase()
    .replace(/[\s'"`+]/g, "")
    .replaceAll("\\", "/")
  if (normalized.includes("request-specs")) {
    throw new Error("Shell access blocked: runtime RequestSpec storage is runtime-owned and not model-writable.")
  }
  if (/opencode(?:-local|-dev)?\.db(?:-wal|-shm)?/.test(normalized)) {
    throw new Error("Shell access blocked: the runtime state database is runtime-owned and not model-writable.")
  }
}

export const _requestSpecsRoot = requestSpecsRoot
