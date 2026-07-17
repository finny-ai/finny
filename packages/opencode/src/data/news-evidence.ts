/**
 * Machine-checkable provenance gate for news_agent / researcher task output.
 *
 * Only sourced_fact and market_data_fact with complete provenance count as
 * evidence. Missing/malformed claims rewrite to deterministic NO_SOURCED_CONTEXT.
 * Prompt-mandated BLOCKED: replies (no claims block) pass through unchanged.
 */

import type { WorkspaceRequestContext } from "@/agent/finny-workspace-context"
import { classifyNewsClaims, countEvidence, identityIssues } from "./news-claims-classify"
import { parseNewsClaimsBlock } from "./news-claims-parse"
import {
  NEWS_CLAIMS_SCHEMA,
  type ClassifiedClaim,
  type NewsClaimsBlock,
  type NewsClaimsResult,
  type NewsEvidenceViolation,
  type NewsEvidenceViolationKind,
} from "./news-claims-types"

export {
  NEWS_CLAIMS_SCHEMA,
  DEFAULT_FRESHNESS_HORIZON_DAYS,
  type NewsClaimClass,
  type NewsClaimsResult,
  type NewsSourceClass,
  type NewsClaim,
  type SourcedFactClaim,
  type MarketDataFactClaim,
  type ModelHypothesisClaim,
  type UnavailableClaim,
  type NewsClaimsIdentity,
  type NewsClaimsBlock,
  type NewsEvidenceViolationKind,
  type NewsEvidenceViolation,
  type ParsedNewsClaims,
  type ClassifiedClaim,
} from "./news-claims-types"
export { parseNewsClaimsBlock } from "./news-claims-parse"
export { classifyNewsClaims, countEvidence, identityIssues } from "./news-claims-classify"

export interface ValidateNewsAgentInput {
  text: string
  workspaceSlug: string | null
  context?: WorkspaceRequestContext
  now?: string
  freshnessHorizonDays?: number
}

export interface ValidateNewsAgentResult {
  ok: boolean
  text: string
  issues: string[]
  claims?: NewsClaimsBlock
  violations?: NewsEvidenceViolation[]
  evidenceCount?: { sourced_fact: number; market_data_fact: number }
}

const BLOCKED_REPLY_RE = /\bBLOCKED:/

function formatUnavailableLine(entry: ClassifiedClaim): string | undefined {
  if (entry.claim.class !== "unavailable") return undefined
  const sc = entry.claim.source_class ?? "unknown"
  const reason = entry.claim.reason ?? "unavailable"
  const recovery = entry.claim.recovery ? `; recovery: ${entry.claim.recovery}` : ""
  return `- ${sc}: ${reason}${recovery}`
}

function formatHardFailLine(entry: ClassifiedClaim): string | undefined {
  const hard = entry.violations.filter((v) => v.kind === "missing_provenance" || v.kind === "future_dated")
  if (hard.length === 0) return undefined
  return `- claim[${entry.index}] (${entry.claim.class}): ${hard.map((v) => v.kind).join(", ")}`
}

function collectAttemptedSources(classified: ClassifiedClaim[]): string[] {
  const lines = classified
    .map((entry) => formatUnavailableLine(entry) ?? formatHardFailLine(entry))
    .filter((line): line is string => Boolean(line))
  return lines.length > 0 ? lines : ["- no source classes reported evidence or failure reasons"]
}

function pushIdentityField(parts: string[], key: string, value: string | undefined): void {
  if (value) parts.push(`${key}=${value}`)
}

function identityLine(workspaceSlug: string | null, context?: WorkspaceRequestContext): string | undefined {
  const parts: string[] = []
  pushIdentityField(parts, "requested_symbol", context?.requested_symbol)
  pushIdentityField(parts, "requested_interval", context?.requested_interval)
  pushIdentityField(parts, "requested_asset_class", context?.requested_asset_class)
  pushIdentityField(parts, "requested_algorithm_name", context?.requested_algorithm_name)
  pushIdentityField(parts, "workspace_slug", workspaceSlug ?? undefined)
  return parts.length > 0 ? `Identity: ${parts.join("; ")}` : undefined
}

function renderNoSourcedContext(input: {
  workspaceSlug: string | null
  context?: WorkspaceRequestContext
  reasons: string[]
  issues: string[]
  classified?: ClassifiedClaim[]
}): string {
  const attempted = input.classified ? collectAttemptedSources(input.classified) : input.reasons.map((r) => `- ${r}`)
  const lines = [
    "NO_SOURCED_CONTEXT: no sourced_fact or market_data_fact claims with complete provenance.",
    identityLine(input.workspaceSlug, input.context),
    "Attempted sources / failure reasons:",
    ...attempted,
    "Do not use model inference as market-context evidence. Retry with free structured feeds (Google News RSS, Yahoo Finance RSS, GDELT, SEC EDGAR FTS, exchange notices) via webfetch, or proceed without news evidence.",
    input.issues.length > 0 ? `Validation issues: ${input.issues.join("; ")}` : undefined,
  ]
  return lines.filter(Boolean).join("\n")
}

function countViolations(violations: NewsEvidenceViolation[], kind: NewsEvidenceViolationKind): number {
  return violations.filter((v) => v.kind === kind).length
}

function identityMismatchViolations(issues: string[]): NewsEvidenceViolation[] {
  return issues
    .filter((issue) => issue.startsWith("identity."))
    .map((detail) => ({ kind: "identity_mismatch" as const, detail }))
}

function renderNewsEvidenceSummary(input: {
  classified: ClassifiedClaim[]
  evidenceCount: { sourced_fact: number; market_data_fact: number }
  result: NewsClaimsResult
  issues?: string[]
}): string {
  const claimViolations = input.classified.flatMap((c) => c.violations)
  const identityViolations = identityMismatchViolations(input.issues ?? [])
  const violations = [...claimViolations, ...identityViolations]
  const lines = [
    "<news-evidence>",
    `result: ${input.result}`,
    `evidence: sourced_fact=${input.evidenceCount.sourced_fact}; market_data_fact=${input.evidenceCount.market_data_fact}`,
    `hypotheses: ${input.classified.filter((c) => c.claim.class === "model_hypothesis").length}`,
    `unavailable: ${input.classified.filter((c) => c.claim.class === "unavailable").length}`,
    `violations: missing_provenance=${countViolations(violations, "missing_provenance")}; future_dated=${countViolations(violations, "future_dated")}; stale_source=${countViolations(violations, "stale_source")}; scheduled_event=${countViolations(violations, "scheduled_event")}; conflict=${countViolations(violations, "conflict")}; identity_mismatch=${countViolations(violations, "identity_mismatch")}`,
  ]
  if (identityViolations.length > 0) {
    lines.push(`issues: ${identityViolations.map((v) => v.detail).join("; ")}`)
  }
  for (const v of violations) {
    const idx = v.claim_index !== undefined ? ` claim[${v.claim_index}]` : ""
    lines.push(`- ${v.kind}${idx}: ${v.detail}`)
  }
  lines.push("</news-evidence>")
  return lines.join("\n")
}

/** Compact claims summary for subagent-artifact pointer lines. */
export function summarizeNewsClaimsForPointer(text: string): string | null {
  const parsed = parseNewsClaimsBlock(text)
  if (!parsed.block) return null
  if (parsed.block.result === "NO_SOURCED_CONTEXT") return "result: NO_SOURCED_CONTEXT"

  const classified = classifyNewsClaims(parsed.block)
  const evidenceCount = countEvidence(classified)
  const total = evidenceCount.sourced_fact + evidenceCount.market_data_fact
  if (total === 0) return "result: NO_SOURCED_CONTEXT"

  const violations = classified.flatMap((c) => c.violations)
  const parts = [
    `evidence: ${evidenceCount.sourced_fact} sourced_fact, ${evidenceCount.market_data_fact} market_data_fact`,
  ]
  if (violations.length > 0) {
    parts.push(`violations: ${[...new Set(violations.map((v) => v.kind))].join(", ")}`)
  }
  return parts.join("; ")
}

function missingClaimsResult(
  input: ValidateNewsAgentInput,
  parseError: string | undefined,
): ValidateNewsAgentResult {
  if (BLOCKED_REPLY_RE.test(input.text)) {
    return {
      ok: false,
      text: input.text,
      issues: ["blocked reply preserved"],
      evidenceCount: { sourced_fact: 0, market_data_fact: 0 },
    }
  }
  const detail = parseError ?? "malformed or missing claims block"
  const issues = [detail]
  return {
    ok: false,
    text: renderNoSourcedContext({
      workspaceSlug: input.workspaceSlug,
      context: input.context,
      reasons: [detail],
      issues,
    }),
    issues,
    violations: [{ kind: "malformed_claims", detail }],
    evidenceCount: { sourced_fact: 0, market_data_fact: 0 },
  }
}

interface EvaluatedClaims {
  input: ValidateNewsAgentInput
  block: NewsClaimsBlock
  classified: ClassifiedClaim[]
  evidenceCount: { sourced_fact: number; market_data_fact: number }
  issues: string[]
}

function noEvidenceResult(evaled: EvaluatedClaims): ValidateNewsAgentResult {
  const totalEvidence = evaled.evidenceCount.sourced_fact + evaled.evidenceCount.market_data_fact
  if (totalEvidence === 0 && evaled.block.result !== "NO_SOURCED_CONTEXT") {
    evaled.issues.push("zero valid evidence claims after provenance checks")
  }
  const violations = evaled.classified.flatMap((c) => c.violations)
  return {
    ok: false,
    text: renderNoSourcedContext({
      workspaceSlug: evaled.input.workspaceSlug,
      context: evaled.input.context,
      reasons: evaled.issues,
      issues: evaled.issues,
      classified: evaled.classified,
    }),
    issues: evaled.issues,
    claims: evaled.block,
    violations: [
      ...violations,
      ...(totalEvidence === 0
        ? [{ kind: "no_evidence" as const, detail: "no sourced_fact or market_data_fact with complete provenance" }]
        : []),
    ],
    evidenceCount: evaled.evidenceCount,
  }
}

function okEvidenceResult(evaled: EvaluatedClaims): ValidateNewsAgentResult {
  const identityViolations = identityMismatchViolations(evaled.issues)
  const claimViolations = evaled.classified.flatMap((c) => c.violations)
  const summary = renderNewsEvidenceSummary({
    classified: evaled.classified,
    evidenceCount: evaled.evidenceCount,
    result: "OK",
    issues: evaled.issues,
  })
  const stripped = evaled.input.text.replace(/<news-evidence>[\s\S]*?<\/news-evidence>\s*/gi, "").trimEnd()
  return {
    ok: true,
    text: `${stripped}\n\n${summary}`,
    issues: evaled.issues,
    claims: evaled.block,
    violations: [...claimViolations, ...identityViolations],
    evidenceCount: evaled.evidenceCount,
  }
}

/** Validate news_agent / researcher task text for machine-checkable provenance. */
export function validateNewsAgentTaskText(input: ValidateNewsAgentInput): ValidateNewsAgentResult {
  const parsed = parseNewsClaimsBlock(input.text)
  if (!parsed.block) return missingClaimsResult(input, parsed.parseError)

  const evaled: EvaluatedClaims = {
    input,
    block: parsed.block,
    issues: identityIssues(parsed.block.identity, input.context),
    classified: classifyNewsClaims(parsed.block, {
      now: input.now,
      freshnessHorizonDays: input.freshnessHorizonDays,
    }),
    evidenceCount: { sourced_fact: 0, market_data_fact: 0 },
  }
  evaled.evidenceCount = countEvidence(evaled.classified)
  const totalEvidence = evaled.evidenceCount.sourced_fact + evaled.evidenceCount.market_data_fact

  if (evaled.block.result === "NO_SOURCED_CONTEXT" || totalEvidence === 0) {
    return noEvidenceResult(evaled)
  }
  return okEvidenceResult(evaled)
}
