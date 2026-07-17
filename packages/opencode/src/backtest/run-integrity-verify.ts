import fs from "node:fs/promises"
import path from "node:path"
import {
  RUN_BUNDLE_SCHEMA,
  RUN_MANIFEST_SCHEMA,
  STRICT_REQUIRED_ARTIFACTS,
  assertRelativeArtifactPath,
  payloadManifestHash,
  readJson,
  sha256File,
  sha256Text,
  stableStringify,
  type IntegrityResult,
  type RunManifestFileV1,
  type RunManifestV1,
  type StrictRunV1,
} from "./run-integrity-core"
import {
  identityArtifactErrors,
  qualificationIdentityErrors,
  recommendationArtifactErrors,
  validateRunIdentity,
} from "./run-integrity-identity"
import { listFiles } from "./run-integrity-publish"

function emptyErrors(): string[] {
  return []
}

function isObject(value: unknown): value is object {
  return !!value && typeof value === "object"
}

function hasIdentity(run: StrictRunV1): boolean {
  return !!run.identity
}

function markOk(errors: string[]): boolean {
  return errors.length === 0
}

function appendError(errors: string[], message: string) {
  errors.push(message)
}

function expectedFilesOf(manifest: RunManifestV1): RunManifestFileV1[] {
  if (!Array.isArray(manifest.files)) return []
  return manifest.files
}

function hasExpectedFiles(files: RunManifestFileV1[]): boolean {
  return files.length > 0
}

const VERDICTS = new Set(["failed", "inconclusive", "weak", "candidate", "recommended_for_paper"])
const ALLOWED_SIDECARS = new Set([
  "run.json",
  "artifact-manifest.json",
  "durability.json",
  "approval.json",
  "live-eligibility.json",
])

interface BundleContext {
  dir: string
  run: StrictRunV1
  manifest: RunManifestV1
  errors: string[]
}

function hasBundleSchema(run: StrictRunV1): boolean {
  if (run.schema !== RUN_BUNDLE_SCHEMA) return false
  return run.version === 1
}

function hasManifestSchema(manifest: RunManifestV1): boolean {
  if (manifest.schema !== RUN_MANIFEST_SCHEMA) return false
  return manifest.version === 1
}

function runIdMatchesDir(ctx: BundleContext): boolean {
  if (!ctx.run.runId) return false
  if (ctx.run.runId !== path.basename(ctx.dir)) return false
  return ctx.manifest.runId === ctx.run.runId
}

function pushBundleSchemaErrors(ctx: BundleContext) {
  if (!hasBundleSchema(ctx.run)) ctx.errors.push("unsupported strict run schema")
  if (!hasManifestSchema(ctx.manifest)) ctx.errors.push("unsupported artifact manifest schema")
  if (!runIdMatchesDir(ctx)) ctx.errors.push("runId does not match bundle path")
}

function pushIdentityHashErrors(ctx: BundleContext) {
  const identityHash = sha256Text(stableStringify(ctx.run.identity))
  if (ctx.run.identityHash !== identityHash) {
    ctx.errors.push("canonical run identity hash mismatch")
    return
  }
  if (ctx.manifest.identityHash !== identityHash) {
    ctx.errors.push("canonical run identity hash mismatch")
  }
}

function hasValidRecommendation(run: StrictRunV1): boolean {
  if (!run.recommendation) return false
  if (!VERDICTS.has(run.recommendation.verdict)) return false
  return Array.isArray(run.recommendation.reasons)
}

function pushRecommendationErrors(ctx: BundleContext) {
  if (!hasValidRecommendation(ctx.run)) {
    ctx.errors.push("computed recommendation is missing or invalid")
  }
  if (ctx.run.validationStatus !== "passed") {
    ctx.errors.push("strict run validation did not pass")
  }
}

interface ManifestCheck {
  dir: string
  expected: RunManifestFileV1
  seen: Set<string>
  errors: string[]
}

function invalidManifestLabel(expected: RunManifestFileV1): string {
  if (expected && typeof expected.path === "string") return expected.path
  return "<invalid>"
}

async function checkManifestEntry(check: ManifestCheck) {
  const label = invalidManifestLabel(check.expected)
  try {
    assertRelativeArtifactPath({ path: label })
    if (check.seen.has(label)) throw new Error("duplicate manifest path")
    check.seen.add(label)
    const file = path.join(check.dir, label)
    const stat = await fs.stat(file)
    if (!stat.isFile()) {
      check.errors.push(`artifact size mismatch: ${label}`)
      return
    }
    if (stat.size !== check.expected.bytes) {
      check.errors.push(`artifact size mismatch: ${label}`)
      return
    }
    if ((await sha256File(file)) !== check.expected.sha256) {
      check.errors.push(`artifact hash mismatch: ${label}`)
    }
  } catch (error) {
    check.errors.push(`artifact invalid: ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function pushRequiredPresence(errors: string[], byPath: Map<string, RunManifestFileV1>) {
  for (const required of STRICT_REQUIRED_ARTIFACTS) {
    const file = byPath.get(required)
    if (!file) {
      errors.push(`required strict run artifact is absent from manifest: ${required}`)
      continue
    }
    if (!Number.isSafeInteger(file.bytes)) {
      errors.push(`required strict run artifact is empty: ${required}`)
      continue
    }
    if (file.bytes <= 0) errors.push(`required strict run artifact is empty: ${required}`)
  }
}

async function loadStrictMetadata(
  dir: string,
): Promise<{ run: StrictRunV1; manifest: RunManifestV1 } | { errors: string[] }> {
  try {
    const run = await readJson<StrictRunV1>({ file: path.join(dir, "run.json") })
    const manifest = await readJson<RunManifestV1>({ file: path.join(dir, "artifact-manifest.json") })
    if (!isObject(run) || !hasIdentity(run as StrictRunV1)) {
      return { errors: ["strict run metadata is missing the v1 identity or manifest"] }
    }
    if (!isObject(manifest)) {
      return { errors: ["strict run metadata is missing the v1 identity or manifest"] }
    }
    return { run, manifest }
  } catch (error) {
    return { errors: [`strict run metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

async function verifyManifestTree(ctx: BundleContext, expectedFiles: RunManifestFileV1[]) {
  const seen = new Set<string>()
  const byPath = new Map<string, RunManifestFileV1>()
  for (const expected of expectedFiles) {
    await checkManifestEntry({ dir: ctx.dir, expected, seen, errors: ctx.errors })
    if (expected && typeof expected.path === "string") byPath.set(expected.path, expected)
  }
  pushRequiredPresence(ctx.errors, byPath)
  try {
    for (const actual of await listFiles({ root: ctx.dir })) {
      if (seen.has(actual.path)) continue
      if (ALLOWED_SIDECARS.has(actual.path)) continue
      ctx.errors.push(`unmanifested artifact: ${actual.path}`)
    }
  } catch (error) {
    ctx.errors.push(`artifact tree is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function verifyCanonicalHashes(ctx: BundleContext, expectedFiles: RunManifestFileV1[]) {
  if (payloadManifestHash(expectedFiles) !== ctx.manifest.manifestHash) {
    ctx.errors.push("artifact manifest canonical hash mismatch")
  }
  if ((await sha256File(path.join(ctx.dir, "run.json"))) !== ctx.manifest.runJsonSha256) {
    ctx.errors.push("run.json hash mismatch")
  }
  ctx.errors.push(...(await identityArtifactErrors(ctx.dir, ctx.run.identity, expectedFiles)))
  ctx.errors.push(...qualificationIdentityErrors(ctx.run.identity, ctx.run.qualification))
  ctx.errors.push(...(await recommendationArtifactErrors(ctx.dir, ctx.run.recommendation, ctx.run.qualification)))
}

export async function verifyStrictRunDir(dir: string): Promise<IntegrityResult> {
  const loaded = await loadStrictMetadata(dir)
  if ("errors" in loaded) return { ok: false, errors: loaded.errors }
  const ctx: BundleContext = {
    dir,
    run: loaded.run,
    manifest: loaded.manifest,
    errors: [],
  }
  ctx.errors.push(...validateRunIdentity(ctx.run.identity))
  pushBundleSchemaErrors(ctx)
  pushIdentityHashErrors(ctx)
  pushRecommendationErrors(ctx)

  const expectedFiles = expectedFilesOf(ctx.manifest)
  if (!hasExpectedFiles(expectedFiles)) appendError(ctx.errors, "artifact manifest has no files")
  await verifyManifestTree(ctx, expectedFiles)
  await verifyCanonicalHashes(ctx, expectedFiles)
  return { ok: markOk(ctx.errors), run: ctx.run, manifest: ctx.manifest, errors: ctx.errors }
}
