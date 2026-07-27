import { sha256Bytes } from "./artifacts"

const VOLATILE_KEYS = new Set([
  "timestamp",
  "time",
  "sessionID",
  "sessionId",
  "session_id",
  "runId",
  "run_id",
  "identityHash",
  "identity_hash",
  "artifactPath",
  "artifact_path",
  "workflowId",
  "workflow_id",
  "experimentId",
  "experiment_id",
  "challengeId",
  "challenge_id",
  "approvalChallengeId",
  "scopeHash",
  "sourceMessageId",
  "questionRequestId",
  "runIdentityHash",
  "strictRunIdentityHash",
  "id",
  "callID",
  "messageID",
  "messageId",
  "request_id",
  "requestHash",
  "request_hash",
  "contentHash",
  "request_content_hash",
  "content_hash",
  "parentSessionId",
  "algorithmId",
  "algorithm_id",
  "conceptId",
  "concept_id",
  "configHash",
  "config_hash",
  "replayKey",
  "replay_key",
  "updated",
  "createdAt",
  "finishedAt",
  "startedAt",
  "snapshot",
])

const INTEGRITY_HASH_KEYS = new Set([
  "scenarioSha256",
  "bunLockSha256",
  "evaluatorSourceSha256",
  "evaluatorEntrypointSha256",
  "manifestHash",
  "manifest_hash",
  "rawDataHash",
  "strategyHash",
])

const STRICT_RUN_IDENTITY_HASH_KEYS = new Set([
  "strategyHash",
  "savedConfigHash",
  "effectiveConfigHash",
  "riskContractHash",
  "rawDataHash",
  "processedDataHash",
  "engineTreeHash",
  "assetProfileHash",
  "executionProfileHash",
  "experimentPlanHash",
  "qualificationPolicyHash",
])

const STRICT_RUN_DOCUMENT_HASH_KEYS = new Set(["mission", "preferences", "decisions", "reasoning"])

function isIntegrityHashKey(key: string | undefined, path: string[]): boolean {
  if (key === undefined) return false
  if (INTEGRITY_HASH_KEYS.has(key)) return true
  if (path.at(-2) === "identity" && STRICT_RUN_IDENTITY_HASH_KEYS.has(key)) return true
  return path.at(-3) === "identity" && path.at(-2) === "documentHashes" && STRICT_RUN_DOCUMENT_HASH_KEYS.has(key)
}

function isVolatileKey(key: string, path: string[]): boolean {
  if (VOLATILE_KEYS.has(key)) return true
  return (key === "manifestHash" || key === "manifest_hash") && path.at(-1) === "identity"
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function scrubVolatileTokens(value: string, volatile: string[], key: string | undefined, path: string[]): string {
  let normalized = value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>")
  for (const token of volatile.filter(Boolean).sort((a, b) => b.length - a.length)) {
    normalized = normalized.replaceAll(token, "<volatile>")
  }
  normalized = normalized.replace(/ses_[A-Za-z0-9_-]+/g, "<session>")
  normalized = normalized.replace(/(?:msg|prt)_[A-Za-z0-9_-]+/g, "<message-part>")
  normalized = normalized.replace(/wf_[a-f0-9]{32}/gi, "<workflow>")
  normalized = normalized.replace(/(?:evt|approval)_[a-z0-9_-]*[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<workflow-event>")
  normalized = normalized.replace(
    /((?:request_)?content_hash\s*[:=]\s*)(?:sha256:)?[a-f0-9]{64}/gi,
    "$1<request-content-hash>",
  )
  if (!isIntegrityHashKey(key, path)) {
    normalized = normalized.replace(/\b(?:sha256:)?[a-f0-9]{64}\b/gi, "<content-hash>")
  }
  normalized = normalized.replace(/[a-z0-9-]+\.\d+\.\d+\.\d+\.\d+\.[a-f0-9]{8}/gi, "<workspace>")
  normalized = normalized.replace(/\d{8}T\d{6}Z-[a-f0-9]+/gi, "<artifact-run>")
  normalized = normalized.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
  return normalized
}

function normalizeSemanticValue(value: unknown, volatile: string[], key?: string, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeSemanticValue(item, volatile, key, path))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([childKey]) => !isVolatileKey(childKey, path))
        .map(([childKey, child]) => [childKey, normalizeSemanticValue(child, volatile, childKey, [...path, childKey])]),
    )
  }
  if (typeof value !== "string") return value
  return scrubVolatileTokens(value, volatile, key, path)
}

export function semanticHash(value: unknown, volatile: string[] = []): string {
  return sha256Bytes(stable(normalizeSemanticValue(value, volatile)))
}
