import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { algoDir, bindSessionWorkspace, ensureAlgoWorkspace, getSessionWorkspace } from "@finny-ai/core/algo"
import type { WorkspaceRequestContext } from "@/agent/finny-workspace-context"
import {
  commitRequestSpec,
  writeRequestSpecProjection,
  type RequestSpec,
} from "@/agent/request-spec"
import { normalizeInterval, normalizeSymbol } from "@/agent/request-identity"
import { finalizeDatasetEvidenceFile } from "@/data/dataset-evidence-finalizer"
import { Flock } from "@/util/flock"

const SHA256_RE = /^[0-9a-f]{64}$/
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/
const ALGORITHM_NAME_RE = /^[a-z0-9][a-z0-9-]{2,63}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_CSV_BYTES = 64 * 1024 * 1024

export class QualificationDatasetImportError extends Error {
  override readonly name = "QualificationDatasetImportError"
}

function invalid(message: string): never {
  throw new QualificationDatasetImportError(message)
}

export interface QualificationDatasetImportV1 {
  sessionId: string
  algorithmName: string
  symbol: string
  assetClass: "equity" | "crypto"
  interval: string
  requestedStart: string
  requestedEnd: string
  csvBase64: string
  csvSha256: string
  providerId: "alpaca" | "binance"
  providerFeed: string
  providerVenue: string
  providerSymbol: string
  priceBasis: "raw" | "adjusted"
  splitTreatment: string
  dividendTreatment: string
  corporateActionStatus: "resolved" | "not_applicable"
}

export interface QualificationDatasetImportResultV1 {
  schemaVersion: 1
  sessionId: string
  workspaceSlug: string
  requestId: string
  requestVersion: number
  requestContentHash: string
  evidenceId: string
  qualification: string
  csvSha256: string
  manifestSha256: string
  outputPath: string
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function requestContext(spec: RequestSpec): WorkspaceRequestContext {
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
  }
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length > Math.ceil((MAX_CSV_BYTES * 4) / 3) + 8) {
    invalid("qualification dataset exceeds the encoded size limit")
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    invalid("qualification dataset is not canonical base64")
  }
  const decoded = Buffer.from(value, "base64")
  if (decoded.length === 0 || decoded.length > MAX_CSV_BYTES) {
    invalid("qualification dataset exceeds the decoded size limit")
  }
  if (decoded.toString("base64") !== value) {
    invalid("qualification dataset is not canonical base64")
  }
  return decoded
}

function validate(input: QualificationDatasetImportV1) {
  if (!SESSION_ID_RE.test(input.sessionId)) invalid("invalid session identity")
  if (!ALGORITHM_NAME_RE.test(input.algorithmName)) invalid("invalid algorithm identity")
  if (!SHA256_RE.test(input.csvSha256)) invalid("invalid qualification dataset hash")
  const symbol = normalizeSymbol(input.symbol)
  if (!symbol) invalid("invalid qualification dataset symbol")
  const interval = normalizeInterval(input.interval)
  if (!interval) invalid("invalid qualification dataset interval")
  if (!DATE_RE.test(input.requestedStart) || !DATE_RE.test(input.requestedEnd)) {
    invalid("qualification dataset window must use date-only UTC values")
  }
  if (input.requestedStart > input.requestedEnd) {
    invalid("qualification dataset window is empty")
  }
  const expectedProvider = input.assetClass === "equity" ? "alpaca" : "binance"
  if (input.providerId !== expectedProvider) {
    invalid("qualification dataset provider does not match asset class")
  }
  if (
    !input.providerFeed.trim() ||
    !input.providerVenue.trim() ||
    !input.providerSymbol.trim() ||
    !input.splitTreatment.trim() ||
    !input.dividendTreatment.trim()
  ) {
    invalid("qualification dataset provenance is incomplete")
  }
  return { symbol, interval }
}

async function atomicDatasetWrite(file: string, csv: Buffer, expectedHash: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    const existing = await fs.readFile(file)
    if (sha256(existing) !== expectedHash) {
      invalid("existing qualification dataset hash conflicts")
    }
    return
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, csv, { mode: 0o600, flag: "wx" })
  await fs.rename(temporary, file)
}

export async function importQualificationDatasetV1(
  input: QualificationDatasetImportV1,
): Promise<QualificationDatasetImportResultV1> {
  const identity = validate(input)
  const csv = decodeBase64(input.csvBase64)
  if (sha256(csv) !== input.csvSha256) {
    invalid("qualification dataset content hash mismatch")
  }

  const ensured = await ensureAlgoWorkspace(input.algorithmName)
  await Flock.withLock(`fund-qualification-session:${input.sessionId}`, async () => {
    const existingWorkspace = await getSessionWorkspace(input.sessionId)
    if (existingWorkspace && existingWorkspace !== ensured.slug) {
      invalid("qualification session is already bound to another workspace")
    }
    if (!existingWorkspace) await bindSessionWorkspace(input.sessionId, ensured.slug)
  })
  const spec = await commitRequestSpec({
    requestID: input.sessionId,
    identity: {
      requested_symbol: identity.symbol,
      requested_asset_class: input.assetClass,
      requested_interval: identity.interval,
      requested_start: input.requestedStart,
      requested_end: input.requestedEnd,
      requested_algorithm_name: input.algorithmName,
    },
    actor: "runtime",
    reason: "fund controller qualification dataset import",
    approvalState: "approved",
  })
  await writeRequestSpecProjection({ workspaceDir: ensured.dir, spec })

  const safeSymbol = identity.symbol.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")
  const relativeCsvPath = `fund-import/${safeSymbol}-${input.csvSha256.slice(0, 24)}.csv`
  const dataRoot = path.join(algoDir(ensured.slug), "data")
  const csvPath = path.join(dataRoot, relativeCsvPath)
  await atomicDatasetWrite(csvPath, csv, input.csvSha256)
  const finalized = await finalizeDatasetEvidenceFile({
    dataRoot,
    csvPath: relativeCsvPath,
    request: requestContext(spec),
    workspaceSlug: ensured.slug,
    canonicalSymbol: identity.symbol,
    provider: {
      id: input.providerId,
      feed: input.providerFeed,
      venue: input.providerVenue,
      providerSymbol: input.providerSymbol,
    },
    priceBasis: {
      basis: input.priceBasis,
      split_treatment: input.splitTreatment,
      dividend_treatment: input.dividendTreatment,
      corporate_action_status: input.corporateActionStatus,
      events: [],
    },
  })
  const manifestSha256 = sha256(await fs.readFile(finalized.manifestPath))
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    workspaceSlug: ensured.slug,
    requestId: spec.request_id,
    requestVersion: spec.request_version,
    requestContentHash: spec.content_hash,
    evidenceId: finalized.manifest.evidence_id,
    qualification: finalized.manifest.qualification.status,
    csvSha256: input.csvSha256,
    manifestSha256,
    outputPath: finalized.outputPath,
  }
}
