import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  RUN_BUNDLE_SCHEMA,
  RUN_IDENTITY_SCHEMA,
  RUN_MANIFEST_SCHEMA,
  STRICT_REQUIRED_ARTIFACTS,
  assertRelativeArtifactPath,
  assertSegment,
  payloadManifestHash,
  sha256File,
  sha256Text,
  stableStringify,
  writeJsonExclusive,
  type PublishStrictRunInput,
  type RunIdentityV1,
  type RunManifestFileV1,
  type RunManifestV1,
  type StrictRunV1,
} from "./run-integrity-core"
import { identityArtifactErrors, recommendationArtifactErrors, validateRunIdentity } from "./run-integrity-identity"

interface TreeWalk {
  root: string
  relative?: string
}

interface StagingContext {
  staging: string
  input: PublishStrictRunInput
}

function emptyTreeError(input: { root: string }): Error {
  return new Error(`cannot hash empty directory tree: ${input.root}`)
}

function noPayloadError(): Error {
  return new Error("strict run has no payload artifacts")
}

function missingArtifactError(input: { relative: string }): Error {
  return new Error(`required strict run artifact missing or empty: ${input.relative}`)
}

function symlinkError(input: { path: string }): Error {
  return new Error(`run artifact may not be a symlink: ${input.path}`)
}

function unsupportedArtifactError(input: { path: string }): Error {
  return new Error(`unsupported run artifact: ${input.path}`)
}

function invalidIdentityError(messages: string[]): Error {
  return new Error(`invalid strict run identity: ${messages.join("; ")}`)
}

function finalDirMismatchError(): Error {
  return new Error("final run directory must end with runId")
}

async function listFiles(walk: TreeWalk): Promise<RunManifestFileV1[]> {
  const relative = walk.relative ?? ""
  const dir = path.join(walk.root, relative)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: RunManifestFileV1[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = relative ? path.posix.join(relative, entry.name) : entry.name
    if (entry.isSymbolicLink()) throw symlinkError({ path: next })
    if (entry.isDirectory()) {
      files.push(...(await listFiles({ root: walk.root, relative: next })))
      continue
    }
    if (!entry.isFile()) throw unsupportedArtifactError({ path: next })
    const file = path.join(walk.root, next)
    const stat = await fs.stat(file)
    files.push({ path: next, sha256: await sha256File(file), bytes: stat.size })
  }
  return files
}

function ignoredTreePath(input: { filePath: string }): boolean {
  const parts = input.filePath.split("/")
  if (parts.includes("__pycache__")) return true
  if (input.filePath.endsWith(".pyc")) return true
  if (input.filePath.endsWith(".pyo")) return true
  if (input.filePath.endsWith(".DS_Store")) return true
  return false
}

export async function directoryTreeManifest(root: string): Promise<RunManifestFileV1[]> {
  const files = (await listFiles({ root })).filter((file) => !ignoredTreePath({ filePath: file.path }))
  if (files.length === 0) throw emptyTreeError({ root })
  return files
}

export async function hashDirectoryTree(root: string): Promise<string> {
  return sha256Text(stableStringify(await directoryTreeManifest(root)))
}

async function copyArtifact(input: { staging: string; artifact: PublishStrictRunInput["artifacts"][number] }) {
  assertRelativeArtifactPath({ path: input.artifact.path })
  const target = path.join(input.staging, input.artifact.path)
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.copyFile(input.artifact.source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if (input.artifact.required !== false) {
      throw new Error(`required strict run artifact missing: ${input.artifact.path}`, { cause: error })
    }
  }
}

async function writeJsonArtifacts(input: { staging: string; jsonArtifacts?: Record<string, unknown> }) {
  for (const [relative, value] of Object.entries(input.jsonArtifacts ?? {})) {
    assertRelativeArtifactPath({ path: relative })
    await writeJsonExclusive({ file: path.join(input.staging, relative), value })
  }
}

async function assertRequiredArtifacts(input: { staging: string; requiredArtifacts: string[] }) {
  for (const relative of new Set<string>([...STRICT_REQUIRED_ARTIFACTS, ...input.requiredArtifacts])) {
    assertRelativeArtifactPath({ path: relative })
    const stat = await fs.stat(path.join(input.staging, relative)).catch(() => null)
    if (!stat?.isFile() || stat.size === 0) throw missingArtifactError({ relative })
  }
}

async function buildValidatedIdentity(input: {
  staging: string
  request: PublishStrictRunInput
  payloadFiles: RunManifestFileV1[]
}): Promise<{ identity: RunIdentityV1; identityHash: string }> {
  const identity: RunIdentityV1 = {
    schema: RUN_IDENTITY_SCHEMA,
    version: 1,
    ...input.request.identity,
  }
  const identityErrors = validateRunIdentity(identity)
  identityErrors.push(...(await identityArtifactErrors(input.staging, identity, input.payloadFiles)))
  identityErrors.push(...(await recommendationArtifactErrors(input.staging, input.request.recommendation)))
  if (identityErrors.length) throw invalidIdentityError(identityErrors)
  return { identity, identityHash: sha256Text(stableStringify(identity)) }
}

function assertFinalDirMatchesRunId(input: { finalDir: string; runId: string }) {
  if (path.basename(input.finalDir) !== input.runId) throw finalDirMismatchError()
}

async function materializeStaging(ctx: StagingContext) {
  for (const artifact of ctx.input.artifacts) await copyArtifact({ staging: ctx.staging, artifact })
  await writeJsonArtifacts({ staging: ctx.staging, jsonArtifacts: ctx.input.jsonArtifacts })
  await assertRequiredArtifacts({ staging: ctx.staging, requiredArtifacts: ctx.input.requiredArtifacts })
}

async function finalizeStrictBundle(ctx: StagingContext): Promise<{ run: StrictRunV1; manifest: RunManifestV1 }> {
  const payloadFiles = await listFiles({ root: ctx.staging })
  if (payloadFiles.length === 0) throw noPayloadError()
  const manifestHash = payloadManifestHash(payloadFiles)
  const { identity, identityHash } = await buildValidatedIdentity({
    staging: ctx.staging,
    request: ctx.input,
    payloadFiles,
  })
  const run: StrictRunV1 = {
    schema: RUN_BUNDLE_SCHEMA,
    version: 1,
    runId: ctx.input.runId,
    productLabel: ctx.input.productLabel ?? "Crucible 2.0",
    runKind: "crucible_2_0",
    createdAt: ctx.input.createdAt ?? new Date().toISOString(),
    identity,
    identityHash,
    recommendation: ctx.input.recommendation,
    validationStatus: "passed",
  }
  await writeJsonExclusive({ file: path.join(ctx.staging, "run.json"), value: run })
  const runJsonSha256 = await sha256File(path.join(ctx.staging, "run.json"))
  const manifest: RunManifestV1 = {
    schema: RUN_MANIFEST_SCHEMA,
    version: 1,
    runId: ctx.input.runId,
    identityHash,
    manifestHash,
    runJsonSha256,
    files: payloadFiles,
  }
  await writeJsonExclusive({ file: path.join(ctx.staging, "artifact-manifest.json"), value: manifest })
  return { run, manifest }
}

export async function publishStrictRun(
  input: PublishStrictRunInput,
): Promise<{ dir: string; run: StrictRunV1; manifest: RunManifestV1 }> {
  assertSegment({ name: "runId", value: input.runId })
  assertFinalDirMatchesRunId({ finalDir: input.finalDir, runId: input.runId })
  const parent = path.dirname(input.finalDir)
  const staging = path.join(parent, `.tmp-${input.runId}`)
  await fs.mkdir(parent, { recursive: true })
  await fs.mkdir(staging)
  const ctx: StagingContext = { staging, input }

  try {
    await materializeStaging(ctx)
    const { run, manifest } = await finalizeStrictBundle(ctx)
    await fs.rename(staging, input.finalDir)
    return { dir: input.finalDir, run, manifest }
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export { listFiles }
