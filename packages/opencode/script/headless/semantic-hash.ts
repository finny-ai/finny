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
  "parentSessionId",
  "algorithmId",
  "algorithm_id",
  "updated",
  "createdAt",
  "finishedAt",
  "startedAt",
])

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function scrubVolatileTokens(value: string, volatile: string[]): string {
  let normalized = value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<timestamp>")
  for (const token of volatile.filter(Boolean).sort((a, b) => b.length - a.length)) {
    normalized = normalized.replaceAll(token, "<volatile>")
  }
  normalized = normalized.replace(/ses_[A-Za-z0-9_-]+/g, "<session>")
  normalized = normalized.replace(/(?:msg|prt)_[A-Za-z0-9_-]+/g, "<message-part>")
  normalized = normalized.replace(/wf_[a-f0-9]{32}/gi, "<workflow>")
  normalized = normalized.replace(/(?:evt|approval)_[a-z0-9_-]*[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<workflow-event>")
  normalized = normalized.replace(/[a-z0-9-]+\.\d+\.\d+\.\d+\.\d+\.[a-f0-9]{8}/gi, "<workspace>")
  normalized = normalized.replace(/\d{8}T\d{6}Z-[a-f0-9]+/gi, "<artifact-run>")
  normalized = normalized.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>")
  return normalized
}

function normalizeSemanticValue(value: unknown, volatile: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeSemanticValue(item, volatile))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !VOLATILE_KEYS.has(key))
        .map(([key, child]) => [key, normalizeSemanticValue(child, volatile)]),
    )
  }
  if (typeof value !== "string") return value
  return scrubVolatileTokens(value, volatile)
}

export function semanticHash(value: unknown, volatile: string[] = []): string {
  return sha256Bytes(stable(normalizeSemanticValue(value, volatile)))
}
