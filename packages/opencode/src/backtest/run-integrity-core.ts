import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import type { Algorithm } from "@/algorithm"
import type { ControllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import type { BacktestRunner } from "./runner"
import type { QualificationInputV1 } from "./qualification-policy"

export const RUN_IDENTITY_SCHEMA = "finny.run_identity" as const
export const RUN_BUNDLE_SCHEMA = "finny.qualification_bundle" as const
export const RUN_MANIFEST_SCHEMA = "finny.run_manifest" as const
export const RUN_APPROVAL_SCHEMA = "finny.run_approval" as const
export const STRICT_REQUIRED_ARTIFACTS = [
  "validation.json",
  "metrics.json",
  "data_quality.json",
  "execution_assumptions.json",
  "execution_profile.json",
  "effective_config.json",
  "engine_tree.json",
  "asset_spec.json",
  "qualification_policy.json",
  "qualification_context.json",
  "results.json",
  "ohlcv.csv",
  "data_extractor.manifest.json",
  "processed_ohlcv.csv",
  "orders.csv",
  "fills.csv",
  "rejections.csv",
] as const

export type Sha256 = string

export interface RunIdentityV1 {
  schema: typeof RUN_IDENTITY_SCHEMA
  version: 1
  algorithmId: string
  algorithmVersion: number
  strategyHash: Sha256
  savedConfigHash: Sha256
  effectiveConfigHash: Sha256
  documentHashes: {
    mission: Sha256
    preferences: Sha256
    decisions: Sha256
    reasoning: Sha256
  }
  riskContractHash: Sha256
  rawDataHash: Sha256
  processedDataHash: Sha256
  manifestHash: Sha256
  engineTreeHash: Sha256
  assetProfileHash: Sha256
  executionProfileHash: Sha256
  experimentPlanId: string
  experimentPlanHash: Sha256
  qualificationPolicyId: string
  qualificationPolicyHash: Sha256
  datasetEvidenceId: string
  datasetQualification: "strict_qualified" | "research_only" | "unqualified"
  dataQualityMode: "strict" | "repair_outliers"
  seed: number
  dateWindow: {
    start: string
    end: string
    interval: string
  }
}

export type RunIdentityInputV1 = Omit<RunIdentityV1, "schema" | "version">

export type RunRecommendation = {
  verdict: "failed" | "inconclusive" | "weak" | "candidate" | "recommended_for_paper"
  reasons: string[]
}

export interface QualificationBundleV1 {
  schema: typeof RUN_BUNDLE_SCHEMA
  version: 1
  runId: string
  productLabel: string
  runKind: "crucible_2_0"
  createdAt: string
  identity: RunIdentityV1
  identityHash: Sha256
  qualification: QualificationInputV1
  recommendation: RunRecommendation
  validationStatus: "passed"
}

export type StrictRunV1 = QualificationBundleV1

export interface RunManifestFileV1 {
  path: string
  sha256: Sha256
  bytes: number
}

export interface RunManifestV1 {
  schema: typeof RUN_MANIFEST_SCHEMA
  version: 1
  runId: string
  identityHash: Sha256
  manifestHash: Sha256
  runJsonSha256: Sha256
  files: RunManifestFileV1[]
}

export interface RunApprovalV1 {
  schema: typeof RUN_APPROVAL_SCHEMA
  version: 1
  runId: string
  identityHash: Sha256
  decision: "paper_eligible" | "live_eligible"
  approvedAt: string
  approvedVia: "algorithm_build_workflow"
  workflowId: string
  challengeId: string
  scopeHash: Sha256
  sourceMessageId?: string
  questionRequestId?: string
}

export interface ArtifactSource {
  source: string
  path: string
  required?: boolean
}

export interface PublishStrictRunInput {
  finalDir: string
  runId: string
  identity: RunIdentityInputV1
  recommendation: RunRecommendation
  qualification: QualificationInputV1
  artifacts: ArtifactSource[]
  jsonArtifacts?: Record<string, unknown>
  requiredArtifacts: string[]
  productLabel?: string
  createdAt?: string
}

export interface IntegrityResult {
  ok: boolean
  run?: StrictRunV1
  manifest?: RunManifestV1
  errors: string[]
}

export const HASH_RE = /^[a-f0-9]{64}$/

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`
}

export function sha256Bytes(input: crypto.BinaryLike): Sha256 {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function sha256Text(input: string): Sha256 {
  return sha256Bytes(input)
}

export function hashTextField(input: { value: string }): Sha256 {
  return sha256Text(input.value)
}

export async function sha256File(file: string): Promise<Sha256> {
  return sha256Bytes(await fs.readFile(file))
}

export function isForbiddenSegment(value: string): boolean {
  if (typeof value !== "string" || !value) return true
  if (value === ".") return true
  if (value === "..") return true
  if (value.includes("/")) return true
  if (value.includes("\\")) return true
  return false
}

export interface NamedPath {
  name: string
  value: string
}

export function assertSegment(input: NamedPath): void {
  if (isForbiddenSegment(input.value)) throw new Error(`${input.name} must be a non-empty path segment`)
}

export function hasPathTraversal(value: string): boolean {
  if (typeof value !== "string" || !value) return true
  if (path.isAbsolute(value)) return true
  return value.split(/[\\/]+/).some((part) => part === ".." || part === "")
}

export function assertRelativeArtifactPath(input: { path: string }): void {
  if (hasPathTraversal(input.path)) throw new Error(`invalid artifact path: ${input.path}`)
}

export async function readJson<T>(input: { file: string }): Promise<T> {
  return JSON.parse(await fs.readFile(input.file, "utf8")) as T
}

export async function writeJsonExclusive(input: { file: string; value: unknown }): Promise<void> {
  await fs.mkdir(path.dirname(input.file), { recursive: true })
  await fs.writeFile(input.file, `${JSON.stringify(input.value, null, 2)}\n`, { flag: "wx" })
}

export function algorithmRoot(input: { algorithmId: string }): string {
  return path.join(finnyArtifactPath("algorithms"), input.algorithmId)
}

export function versionDir(input: { algorithmId: string; version: number }): string {
  return path.join(algorithmRoot(input), `v${String(input.version).padStart(2, "0")}`)
}

export function strictRunDir(algorithm: Pick<Algorithm.Info, "algorithmId" | "version">, runId: string): string {
  assertSegment({ name: "runId", value: runId })
  return path.join(versionDir(algorithm), "runs", runId)
}

export function payloadManifestHash(files: RunManifestFileV1[]): Sha256 {
  return sha256Text(stableStringify(files))
}

export type { Algorithm, ControllerPaperApproval, BacktestRunner }
