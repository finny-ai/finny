/**
 * Parse finny.news.claims.v1 fenced JSON from news agent notes/briefs.
 * Continues past unparseable fences so a later valid block still wins.
 */

import {
  NEWS_CLAIMS_SCHEMA,
  type NewsClaim,
  type NewsClaimClass,
  type NewsClaimsBlock,
  type NewsClaimsIdentity,
  type NewsClaimsResult,
  type ParsedNewsClaims,
} from "./news-claims-types"

const CLAIMS_FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/gi

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const nums = value.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
  return nums.length > 0 ? nums : undefined
}

function looksLikeClaimsSchema(raw: string): boolean {
  return raw.includes(NEWS_CLAIMS_SCHEMA) || /"schema"\s*:\s*"finny\.news\.claims/.test(raw)
}

function fenceBodies(text: string): string[] {
  return Array.from(text.matchAll(CLAIMS_FENCE_RE))
    .map((match) => match[1]?.trim())
    .filter((raw): raw is string => Boolean(raw))
}

function normalizeSourcedFact(raw: Record<string, unknown>, conflicts?: number[]): NewsClaim | null {
  const statement = asString(raw.statement)
  if (!statement) return null
  return {
    class: "sourced_fact",
    statement,
    source_url: asString(raw.source_url),
    provider: asString(raw.provider),
    published_at: asString(raw.published_at),
    event_time: asString(raw.event_time),
    retrieved_at: asString(raw.retrieved_at),
    excerpt: asString(raw.excerpt),
    conflicts_with: conflicts,
  }
}

function normalizeMarketDataFact(raw: Record<string, unknown>, conflicts?: number[]): NewsClaim | null {
  const statement = asString(raw.statement)
  if (!statement) return null
  return {
    class: "market_data_fact",
    statement,
    dataset: asString(raw.dataset),
    symbol: asString(raw.symbol),
    interval: asString(raw.interval),
    window: asString(raw.window),
    computation: asString(raw.computation),
    conflicts_with: conflicts,
  }
}

function normalizeClaim(raw: unknown): NewsClaim | null {
  if (!isRecord(raw)) return null
  const klass = asString(raw.class) as NewsClaimClass | undefined
  if (!klass) return null
  const conflicts = asNumberArray(raw.conflicts_with)

  if (klass === "sourced_fact") return normalizeSourcedFact(raw, conflicts)
  if (klass === "market_data_fact") return normalizeMarketDataFact(raw, conflicts)
  if (klass === "model_hypothesis") {
    const statement = asString(raw.statement)
    if (!statement) return null
    return { class: "model_hypothesis", statement, conflicts_with: conflicts }
  }
  if (klass === "unavailable") {
    return {
      class: "unavailable",
      statement: asString(raw.statement),
      source_class: asString(raw.source_class),
      reason: asString(raw.reason),
      recovery: asString(raw.recovery),
      conflicts_with: conflicts,
    }
  }
  return null
}

function normalizeIdentity(raw: unknown): NewsClaimsIdentity | undefined {
  if (!isRecord(raw)) return undefined
  return {
    requested_symbol: asString(raw.requested_symbol),
    requested_interval: asString(raw.requested_interval),
    requested_asset_class: asString(raw.requested_asset_class),
    requested_algorithm_name: asString(raw.requested_algorithm_name),
  }
}

function normalizeClaimsBlock(parsed: unknown): NewsClaimsBlock | null {
  if (!isRecord(parsed)) return null
  if (asString(parsed.schema) !== NEWS_CLAIMS_SCHEMA) return null

  const resultRaw = asString(parsed.result)
  const result: NewsClaimsResult =
    resultRaw === "NO_SOURCED_CONTEXT" || resultRaw === "OK" ? resultRaw : "OK"

  const claimsRaw = Array.isArray(parsed.claims) ? parsed.claims : []
  return {
    schema: NEWS_CLAIMS_SCHEMA,
    result,
    identity: normalizeIdentity(parsed.identity),
    retrieved_at: asString(parsed.retrieved_at),
    claims: claimsRaw.map(normalizeClaim).filter((c): c is NewsClaim => c !== null),
  }
}

type FenceHit = { block: NewsClaimsBlock; raw: string } | { error: string }

function tryFence(raw: string): FenceHit | null {
  try {
    const block = normalizeClaimsBlock(JSON.parse(raw) as unknown)
    return block ? { block, raw } : null
  } catch (err: any) {
    return { error: err?.message ?? String(err) }
  }
}

function acceptSchemaFence(raw: string): boolean {
  return looksLikeClaimsSchema(raw)
}

function acceptFallbackFence(raw: string): boolean {
  return raw.startsWith("{") && !looksLikeClaimsSchema(raw)
}

function firstMatchingFence(bodies: string[], accept: (raw: string) => boolean): ParsedNewsClaims | null {
  let lastParseError: string | undefined
  for (const raw of bodies) {
    if (!accept(raw)) continue
    const hit = tryFence(raw)
    if (!hit) continue
    if ("block" in hit) return hit
    lastParseError = hit.error
  }
  if (!lastParseError) return null
  return { block: null, raw: null, parseError: lastParseError }
}

function unresolvedClaimsError(...attempts: Array<ParsedNewsClaims | null>): ParsedNewsClaims {
  const parseError =
    attempts.find((a) => a?.parseError)?.parseError ?? "no finny.news.claims.v1 fenced JSON block found"
  return { block: null, raw: null, parseError }
}

/** Extract the first finny.news.claims.v1 fenced JSON block from text. */
export function parseNewsClaimsBlock(text: string): ParsedNewsClaims {
  if (!text?.trim()) return { block: null, raw: null, parseError: "empty text" }

  const bodies = fenceBodies(text)
  const preferred = firstMatchingFence(bodies, acceptSchemaFence)
  if (preferred?.block) return preferred

  const fallback = firstMatchingFence(bodies, acceptFallbackFence)
  if (fallback?.block) return fallback

  return unresolvedClaimsError(preferred, fallback)
}
