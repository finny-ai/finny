/**
 * Classify news claims: only complete sourced_fact / market_data_fact count as evidence.
 */

import type { WorkspaceRequestContext } from "@/agent/finny-workspace-context"
import { normalizeInterval, normalizeSymbol } from "@/agent/request-identity"
import {
  DEFAULT_FRESHNESS_HORIZON_DAYS,
  type ClassifiedClaim,
  type MarketDataFactClaim,
  type NewsClaim,
  type NewsClaimsBlock,
  type NewsClaimsIdentity,
  type NewsEvidenceViolation,
  type SourcedFactClaim,
} from "./news-claims-types"

/** Wall-clock + freshness horizon used while classifying claims. */
interface FreshnessClock {
  nowMs: number
  horizonDays: number
  horizonMs: number
  blockRetrievedMs?: number
}

/** A claim being classified, with its index and clock context. */
interface ClaimEvalContext {
  index: number
  clock: FreshnessClock
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function buildClock(
  options: { now?: string; freshnessHorizonDays?: number } | undefined,
  blockRetrievedAt: string | undefined,
): FreshnessClock {
  const horizonDays = options?.freshnessHorizonDays ?? DEFAULT_FRESHNESS_HORIZON_DAYS
  return {
    nowMs: parseIsoMs(options?.now) ?? Date.now(),
    horizonDays,
    horizonMs: horizonDays * 24 * 60 * 60 * 1000,
    blockRetrievedMs: parseIsoMs(blockRetrievedAt),
  }
}

function contextSymbolUniverse(context: WorkspaceRequestContext): string[] {
  const list = context.requested_symbols?.length
    ? context.requested_symbols
    : context.requested_symbol
      ? [context.requested_symbol]
      : []
  return list.map((s) => normalizeSymbol(s)).filter((s): s is string => Boolean(s))
}

interface IdentityFieldCompare {
  field: keyof NewsClaimsIdentity
  claimsValue?: string
  expectedValue?: string
  normalize: (v: string) => string | undefined
}

function fieldMismatch(compare: IdentityFieldCompare): string | undefined {
  if (!compare.claimsValue || !compare.expectedValue) return undefined
  const a = compare.normalize(compare.claimsValue)
  const b = compare.normalize(compare.expectedValue)
  if (!a || !b || a === b) return undefined
  return `identity.${compare.field} differs from runtime context (claims=${compare.claimsValue}, expected=${compare.expectedValue})`
}

function lower(value: string): string {
  return value.trim().toLowerCase()
}

function symbolIdentityIssue(identity: NewsClaimsIdentity, context: WorkspaceRequestContext): string | undefined {
  if (!identity.requested_symbol) return undefined
  const allowed = contextSymbolUniverse(context)
  if (allowed.length === 0) return undefined
  const sym = normalizeSymbol(identity.requested_symbol)
  if (!sym || allowed.includes(sym)) return undefined
  return `identity.requested_symbol differs from runtime context (claims=${identity.requested_symbol}, expected one of ${allowed.join(",")})`
}

function scalarIdentityIssues(identity: NewsClaimsIdentity, context: WorkspaceRequestContext): string[] {
  const compares: IdentityFieldCompare[] = [
    {
      field: "requested_interval",
      claimsValue: identity.requested_interval,
      expectedValue: context.requested_interval,
      normalize: normalizeInterval,
    },
    {
      field: "requested_asset_class",
      claimsValue: identity.requested_asset_class,
      expectedValue: context.requested_asset_class,
      normalize: lower,
    },
    {
      field: "requested_algorithm_name",
      claimsValue: identity.requested_algorithm_name,
      expectedValue: context.requested_algorithm_name,
      normalize: lower,
    },
  ]
  return compares.map(fieldMismatch).filter((issue): issue is string => Boolean(issue))
}

/** Compare claims identity to runtime workspace request context. */
export function identityIssues(
  identity: NewsClaimsIdentity | undefined,
  context?: WorkspaceRequestContext,
): string[] {
  if (!context || !identity) return []
  const symbolIssue = symbolIdentityIssue(identity, context)
  const scalar = scalarIdentityIssues(identity, context)
  return symbolIssue ? [symbolIssue, ...scalar] : scalar
}

function missingProvenance(ctx: ClaimEvalContext, klass: "sourced_fact" | "market_data_fact", missing: string[]): NewsEvidenceViolation {
  return {
    kind: "missing_provenance",
    claim_index: ctx.index,
    detail: `${klass} missing ${missing.join(", ")} — downgraded, not evidence`,
  }
}

function publishedAfterRetrieval(ctx: ClaimEvalContext, claim: SourcedFactClaim): NewsEvidenceViolation {
  return {
    kind: "future_dated",
    claim_index: ctx.index,
    detail: `published_at (${claim.published_at}) after retrieved_at (${claim.retrieved_at}) — temporal leakage, not evidence`,
  }
}

function sourcedMissing(claim: SourcedFactClaim): string[] {
  const missing: string[] = []
  if (!claim.source_url) missing.push("source_url")
  if (!claim.published_at) missing.push("published_at")
  if (!claim.retrieved_at) missing.push("retrieved_at")
  if (!claim.excerpt) missing.push("excerpt")
  return missing
}

function marketMissing(claim: MarketDataFactClaim): string[] {
  const missing: string[] = []
  if (!claim.dataset) missing.push("dataset")
  if (!claim.symbol) missing.push("symbol")
  if (!claim.computation) missing.push("computation")
  return missing
}

/**
 * Temporal leakage is published_at after retrieval only.
 * A future event_time is valid for scheduled catalysts (earnings, FOMC, rebalance)
 * when the source was published at or before retrieval.
 */
function publicationLeak(claim: SourcedFactClaim, ctx: ClaimEvalContext): NewsEvidenceViolation | undefined {
  const retrievedMs = parseIsoMs(claim.retrieved_at) ?? ctx.clock.blockRetrievedMs
  if (retrievedMs === undefined) return undefined
  const publishedMs = parseIsoMs(claim.published_at)
  if (publishedMs !== undefined && publishedMs > retrievedMs) {
    return publishedAfterRetrieval(ctx, claim)
  }
  return undefined
}

function scheduledEventFlag(claim: SourcedFactClaim, ctx: ClaimEvalContext): NewsEvidenceViolation | undefined {
  const eventMs = parseIsoMs(claim.event_time)
  if (eventMs === undefined) return undefined
  if (eventMs <= ctx.clock.nowMs) return undefined
  return {
    kind: "scheduled_event",
    claim_index: ctx.index,
    detail: `event_time (${claim.event_time}) is in the future — scheduled catalyst, still evidence`,
  }
}

/** Source freshness uses publication time, not the market event time. */
function staleFlag(claim: SourcedFactClaim, ctx: ClaimEvalContext): NewsEvidenceViolation | undefined {
  const publishedMs = parseIsoMs(claim.published_at)
  if (publishedMs === undefined || ctx.clock.nowMs - publishedMs <= ctx.clock.horizonMs) return undefined
  return {
    kind: "stale_source",
    claim_index: ctx.index,
    detail: `published_at older than ${ctx.clock.horizonDays}d freshness horizon — flagged stale`,
  }
}

function classifySourcedFact(
  claim: SourcedFactClaim,
  ctx: ClaimEvalContext,
): Pick<ClassifiedClaim, "isEvidence" | "violations"> {
  const missing = sourcedMissing(claim)
  if (missing.length > 0) {
    return { isEvidence: false, violations: [missingProvenance(ctx, "sourced_fact", missing)] }
  }

  const leak = publicationLeak(claim, ctx)
  if (leak) return { isEvidence: false, violations: [leak] }

  const violations: NewsEvidenceViolation[] = []
  const stale = staleFlag(claim, ctx)
  if (stale) violations.push(stale)
  const scheduled = scheduledEventFlag(claim, ctx)
  if (scheduled) violations.push(scheduled)
  return { isEvidence: true, violations }
}

function classifyMarketDataFact(
  claim: MarketDataFactClaim,
  ctx: ClaimEvalContext,
): Pick<ClassifiedClaim, "isEvidence" | "violations"> {
  const missing = marketMissing(claim)
  if (missing.length > 0) {
    return { isEvidence: false, violations: [missingProvenance(ctx, "market_data_fact", missing)] }
  }
  return { isEvidence: true, violations: [] }
}

function classifyOne(claim: NewsClaim, ctx: ClaimEvalContext): ClassifiedClaim {
  if (claim.class === "sourced_fact") {
    return { index: ctx.index, claim, ...classifySourcedFact(claim, ctx) }
  }
  if (claim.class === "market_data_fact") {
    return { index: ctx.index, claim, ...classifyMarketDataFact(claim, ctx) }
  }
  return { index: ctx.index, claim, isEvidence: false, violations: [] }
}

/** Record each undirected conflict pair once (avoids double-count on mutual conflicts_with). */
function applyConflicts(classified: ClassifiedClaim[]): void {
  const seen = new Set<string>()
  for (const entry of classified) {
    for (const other of entry.claim.conflicts_with ?? []) {
      if (other < 0 || other >= classified.length) continue
      if (!entry.isEvidence && !classified[other].isEvidence) continue
      const lo = Math.min(entry.index, other)
      const hi = Math.max(entry.index, other)
      const key = `${lo}:${hi}`
      if (seen.has(key)) continue
      seen.add(key)
      const detail = `claims[${lo}] conflicts_with claims[${hi}]`
      classified[lo].violations.push({ kind: "conflict", claim_index: lo, detail })
      classified[hi].violations.push({ kind: "conflict", claim_index: hi, detail })
    }
  }
}

/** Classify each claim as evidence or downgraded, with violation flags. */
export function classifyNewsClaims(
  block: NewsClaimsBlock,
  options?: { now?: string; freshnessHorizonDays?: number },
): ClassifiedClaim[] {
  const clock = buildClock(options, block.retrieved_at)
  const classified = block.claims.map((claim, index) => classifyOne(claim, { index, clock }))
  applyConflicts(classified)
  return classified
}

export function countEvidence(classified: ClassifiedClaim[]): {
  sourced_fact: number
  market_data_fact: number
} {
  return {
    sourced_fact: classified.filter((c) => c.isEvidence && c.claim.class === "sourced_fact").length,
    market_data_fact: classified.filter((c) => c.isEvidence && c.claim.class === "market_data_fact").length,
  }
}
