import path from "node:path"
import {
  HASH_RE,
  RUN_IDENTITY_SCHEMA,
  readJson,
  sha256File,
  sha256Text,
  stableStringify,
  type RunIdentityV1,
  type RunManifestFileV1,
  type RunRecommendation,
  type Sha256,
} from "./run-integrity-core"
import type { BacktestRunner } from "./runner"
import { verifyQualificationPolicyV1, type QualificationInputV1 } from "./qualification-policy"
import { qualifyCandidateV1 } from "./qualification"

function requiredHashes(identity: RunIdentityV1): Array<[string, unknown]> {
  return [
    ["strategyHash", identity.strategyHash],
    ["savedConfigHash", identity.savedConfigHash],
    ["effectiveConfigHash", identity.effectiveConfigHash],
    ["documentHashes.mission", identity.documentHashes?.mission],
    ["documentHashes.preferences", identity.documentHashes?.preferences],
    ["documentHashes.decisions", identity.documentHashes?.decisions],
    ["documentHashes.reasoning", identity.documentHashes?.reasoning],
    ["riskContractHash", identity.riskContractHash],
    ["rawDataHash", identity.rawDataHash],
    ["processedDataHash", identity.processedDataHash],
    ["manifestHash", identity.manifestHash],
    ["engineTreeHash", identity.engineTreeHash],
    ["assetProfileHash", identity.assetProfileHash],
    ["executionProfileHash", identity.executionProfileHash],
    ["experimentPlanHash", identity.experimentPlanHash],
    ["qualificationPolicyHash", identity.qualificationPolicyHash],
  ]
}

interface NamedValue {
  name: string
  value: unknown
}

function pushMissingHash(errors: string[], field: NamedValue) {
  if (typeof field.value !== "string") {
    errors.push(`${field.name} must be a non-empty SHA-256 hash`)
    return
  }
  if (!HASH_RE.test(field.value)) errors.push(`${field.name} must be a non-empty SHA-256 hash`)
}

function pushSchemaErrors(errors: string[], identity: RunIdentityV1) {
  if (identity.schema !== RUN_IDENTITY_SCHEMA) errors.push("unsupported run identity schema")
  if (identity.version !== 1) errors.push("unsupported run identity schema")
}

function missingAlgorithmId(identity: RunIdentityV1): boolean {
  return !identity.algorithmId
}

function invalidAlgorithmVersion(identity: RunIdentityV1): boolean {
  if (!Number.isInteger(identity.algorithmVersion)) return true
  return identity.algorithmVersion < 1
}

function invalidSeed(identity: RunIdentityV1): boolean {
  if (!Number.isSafeInteger(identity.seed)) return true
  return identity.seed < 0
}

function incompleteDateWindow(identity: RunIdentityV1): boolean {
  if (!identity.dateWindow?.start) return true
  if (!identity.dateWindow.end) return true
  if (!identity.dateWindow.interval) return true
  return false
}

function pushIdentityFieldErrors(errors: string[], identity: RunIdentityV1) {
  if (missingAlgorithmId(identity)) errors.push("algorithmId is required")
  if (invalidAlgorithmVersion(identity)) errors.push("algorithmVersion must be positive")
  if (invalidSeed(identity)) errors.push("seed must be a non-negative safe integer")
  if (incompleteDateWindow(identity)) errors.push("date window is incomplete")
  if (!identity.experimentPlanId) errors.push("experimentPlanId is required")
  if (!identity.qualificationPolicyId) errors.push("qualificationPolicyId is required")
  if (!identity.datasetEvidenceId) errors.push("datasetEvidenceId is required")
  if (!identity.datasetQualification) errors.push("datasetQualification is required")
  if (!identity.dataQualityMode) errors.push("dataQualityMode is required")
}

export function validateRunIdentity(identity: RunIdentityV1 | null | undefined): string[] {
  if (!identity || typeof identity !== "object") return ["run identity is missing"]
  const errors: string[] = []
  pushSchemaErrors(errors, identity)
  pushIdentityFieldErrors(errors, identity)
  for (const [name, value] of requiredHashes(identity)) pushMissingHash(errors, { name, value })
  return errors
}

interface HashBinding {
  relative: string
  expected: Sha256
  label: string
}

function csvHashMismatch(byPath: Map<string, RunManifestFileV1>, binding: HashBinding) {
  if (byPath.get(binding.relative)?.sha256 !== binding.expected) {
    return `${binding.label} does not match ${binding.relative}`
  }
  return undefined
}

const SEMANTIC_BINDINGS: Array<(identity: RunIdentityV1) => HashBinding> = [
  (identity) => ({
    relative: "effective_config.json",
    expected: identity.effectiveConfigHash,
    label: "effectiveConfigHash",
  }),
  (identity) => ({ relative: "asset_spec.json", expected: identity.assetProfileHash, label: "assetProfileHash" }),
  (identity) => ({
    relative: "execution_profile.json",
    expected: identity.executionProfileHash,
    label: "executionProfileHash",
  }),
  (identity) => ({ relative: "engine_tree.json", expected: identity.engineTreeHash, label: "engineTreeHash" }),
]

async function semanticBindingError(root: string, binding: HashBinding) {
  try {
    const value = await readJson<unknown>({ file: path.join(root, binding.relative) })
    if (sha256Text(stableStringify(value)) !== binding.expected) {
      return `${binding.label} does not match ${binding.relative}`
    }
    return undefined
  } catch (error) {
    return `${binding.relative} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
  }
}

function csvBindings(identity: RunIdentityV1): HashBinding[] {
  return [
    { relative: "ohlcv.csv", expected: identity.rawDataHash, label: "rawDataHash" },
    { relative: "processed_ohlcv.csv", expected: identity.processedDataHash, label: "processedDataHash" },
    { relative: "data_extractor.manifest.json", expected: identity.manifestHash, label: "manifestHash" },
  ]
}

export async function identityArtifactErrors(
  root: string,
  identity: RunIdentityV1,
  files: RunManifestFileV1[],
): Promise<string[]> {
  const errors: string[] = []
  const byPath = new Map(files.map((file) => [file.path, file]))
  for (const binding of csvBindings(identity)) {
    const mismatch = csvHashMismatch(byPath, binding)
    if (mismatch) errors.push(mismatch)
  }
  for (const make of SEMANTIC_BINDINGS) {
    const issue = await semanticBindingError(root, make(identity))
    if (issue) errors.push(issue)
  }
  return errors
}

export async function recommendationArtifactErrors(
  root: string,
  recommendation: RunRecommendation,
  qualification: QualificationInputV1 | undefined,
): Promise<string[]> {
  const errors: string[] = verifyQualificationPolicyV1(qualification?.policy)
  try {
    const policy = await readJson<unknown>({ file: path.join(root, "qualification_policy.json") })
    const context = await readJson<unknown>({ file: path.join(root, "qualification_context.json") })
    if (stableStringify(policy) !== stableStringify(qualification?.policy))
      errors.push("qualification_policy.json does not match the bundle policy")
    if (stableStringify(context) !== stableStringify(qualification?.context))
      errors.push("qualification_context.json does not match the bundle context")
  } catch (error) {
    errors.push(`qualification artifacts are invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const validation = await readJson<{ valid?: boolean }>({ file: path.join(root, "validation.json") })
    if (validation.valid !== true) errors.push("validationStatus does not match validation.json")
  } catch (error) {
    errors.push(`validation.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    if (!qualification) throw new Error("qualification policy and context are missing")
    const results = await readJson<BacktestRunner.Results>({ file: path.join(root, "metrics.json") })
    const recomputed = qualifyCandidateV1({
      candidateId: "bundle-recomputation",
      results,
      qualification,
    }).recommendation
    if (stableStringify(recomputed) !== stableStringify(recommendation)) {
      errors.push("computed recommendation does not match metrics.json")
    }
  } catch (error) {
    errors.push(
      `metrics.json cannot reproduce recommendation: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return errors
}

export function qualificationIdentityErrors(
  identity: RunIdentityV1,
  qualification: QualificationInputV1 | undefined,
): string[] {
  const errors: string[] = []
  if (!qualification?.policy || !qualification.context) return ["qualification policy and context are missing"]
  if (identity.experimentPlanId !== qualification.context.planId)
    errors.push("experiment plan id does not match qualification context")
  if (identity.experimentPlanHash !== qualification.context.planHash)
    errors.push("experiment plan hash does not match qualification context")
  if (identity.qualificationPolicyId !== qualification.policy.policyId)
    errors.push("qualification policy id does not match bundle")
  if (identity.qualificationPolicyHash !== qualification.policy.policyHash)
    errors.push("qualification policy hash does not match bundle")
  if (identity.datasetEvidenceId !== qualification.context.datasetEvidenceId)
    errors.push("dataset evidence id does not match qualification context")
  if (identity.rawDataHash !== qualification.context.datasetHash)
    errors.push("dataset hash does not match run raw data")
  if (identity.datasetQualification !== qualification.context.datasetQualification)
    errors.push("dataset qualification does not match context")
  if (identity.dataQualityMode !== qualification.context.dataQualityMode)
    errors.push("data quality mode does not match context")
  return errors
}
