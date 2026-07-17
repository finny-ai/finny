/** Shared types for the news claims provenance contract (finny.news.claims.v1). */

export const NEWS_CLAIMS_SCHEMA = "finny.news.claims.v1" as const
export const DEFAULT_FRESHNESS_HORIZON_DAYS = 45

export type NewsClaimClass = "sourced_fact" | "market_data_fact" | "model_hypothesis" | "unavailable"
export type NewsClaimsResult = "OK" | "NO_SOURCED_CONTEXT"

export type NewsSourceClass =
  | "google_news_rss"
  | "yahoo_finance_rss"
  | "gdelt"
  | "sec_edgar"
  | "exchange_notice"
  | "coindesk_rss"
  | "websearch"
  | "webfetch"
  | "discord"
  | "other"

export interface NewsClaimBase {
  class: NewsClaimClass
  statement?: string
  /** 0-based indexes into claims[] that conflict with this claim. */
  conflicts_with?: number[]
}

export interface SourcedFactClaim extends NewsClaimBase {
  class: "sourced_fact"
  statement: string
  source_url?: string
  provider?: string
  published_at?: string
  event_time?: string
  retrieved_at?: string
  excerpt?: string
}

export interface MarketDataFactClaim extends NewsClaimBase {
  class: "market_data_fact"
  statement: string
  dataset?: string
  symbol?: string
  interval?: string
  window?: string
  computation?: string
}

export interface ModelHypothesisClaim extends NewsClaimBase {
  class: "model_hypothesis"
  statement: string
}

export interface UnavailableClaim extends NewsClaimBase {
  class: "unavailable"
  source_class?: string
  reason?: string
  recovery?: string
}

export type NewsClaim = SourcedFactClaim | MarketDataFactClaim | ModelHypothesisClaim | UnavailableClaim

export interface NewsClaimsIdentity {
  requested_symbol?: string
  requested_interval?: string
  requested_asset_class?: string
  requested_algorithm_name?: string
}

export interface NewsClaimsBlock {
  schema: typeof NEWS_CLAIMS_SCHEMA
  result: NewsClaimsResult
  identity?: NewsClaimsIdentity
  retrieved_at?: string
  claims: NewsClaim[]
}

export type NewsEvidenceViolationKind =
  | "missing_provenance"
  | "future_dated"
  | "stale_source"
  | "scheduled_event"
  | "identity_mismatch"
  | "malformed_claims"
  | "conflict"
  | "no_evidence"

export interface NewsEvidenceViolation {
  kind: NewsEvidenceViolationKind
  claim_index?: number
  detail: string
}

export interface ParsedNewsClaims {
  block: NewsClaimsBlock | null
  raw: string | null
  parseError?: string
}

export interface ClassifiedClaim {
  index: number
  claim: NewsClaim
  isEvidence: boolean
  violations: NewsEvidenceViolation[]
}
