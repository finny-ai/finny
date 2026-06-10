/**
 * Request identity contract.
 *
 * Build mode launches mandatory subagents (data_extractor, researcher) that can
 * write and read artifacts under `algos/_template/data/`. Those artifacts are
 * NOT globally reusable: a note written for one algorithm/symbol must never be
 * reused as evidence for a different request. This module parses the immutable
 * facts of a build request and verifies that any subagent result or artifact
 * actually belongs to that request before it is summarized or used.
 *
 * The check is intentionally code-level (not just prompt wording): a mismatch is
 * a hard context-integrity failure that returns a `BLOCKED:` message.
 */

import { resolveSymbol, SUPPORTED_SYMBOLS } from "../data/symbols"

export type AssetClass = "crypto" | "equity"

/** Immutable facts parsed from the user's build prompt. */
export interface RequestFacts {
  requested_symbol?: string
  requested_interval?: string
  requested_asset_class?: AssetClass
  requested_algorithm_name?: string
}

/**
 * Identity metadata a subagent (or artifact note) must carry so the parent can
 * verify provenance. Anything that influences strategy design must be tied back
 * to these fields — never inferred from prose.
 */
export interface ArtifactIdentity {
  requested_symbol?: string
  requested_interval?: string
  requested_asset_class?: string
  requested_algorithm_name?: string
  actual_symbol?: string
  actual_interval?: string
  actual_asset_class?: string
  /** Algorithm/workspace the artifact belongs to, e.g. "btc-usdt-5m-momentum". */
  algorithm_name?: string
  artifact_paths?: string[]
  request_id?: string
  run_id?: string
}

export type VerifyStatus = "ok" | "blocked" | "insufficient"

export interface VerifyResult {
  ok: boolean
  status: VerifyStatus
  /** Present when status is "blocked": the exact `BLOCKED:` message to surface. */
  blocked?: string
  reason?: string
}

// ── Normalization ───────────────────────────────────────────────────────────

/** Collapse a symbol to its bare base ticker: "BTC/USD" → "BTC", "btc-usdt" → "BTC". */
export function normalizeSymbol(input?: string): string | undefined {
  if (!input) return undefined
  let s = input.trim().toUpperCase()
  // Strip common quote-currency suffixes and pair separators.
  s = s.replace(/[\s_]+/g, "")
  s = s.replace(/[\/\-]?(USDT|USDC|USD|PERP)$/i, "")
  s = s.replace(/[\/\-]+$/g, "")
  return s || undefined
}

/** Canonical interval token: "15min"/"15-minute"/"15 m" → "15m"; "60m"/"1hour" → "1h". */
export function normalizeInterval(input?: string): string | undefined {
  if (!input) return undefined
  const m = /(\d+)\s*-?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(input.trim())
  if (!m) return undefined
  let n = parseInt(m[1]!, 10)
  const unit = m[2]!.toLowerCase()
  if (/^m/.test(unit)) {
    if (n % 60 === 0 && n >= 60) return `${n / 60}h`
    return `${n}m`
  }
  if (/^h/.test(unit)) return `${n}h`
  return `${n}d`
}

/** Render a canonical interval for human-facing messages: "15m" → "15min". */
function displayInterval(canonical?: string): string | undefined {
  if (!canonical) return undefined
  const m = /^(\d+)([mhd])$/.exec(canonical)
  if (!m) return canonical
  const n = m[1]
  switch (m[2]) {
    case "m":
      return `${n}min`
    case "h":
      return `${n}h`
    default:
      return `${n}d`
  }
}

function kindToAssetClass(kind: string): AssetClass {
  return kind === "crypto" ? "crypto" : "equity"
}

const PAIR_RE = /^([A-Z0-9]{2,6})[-/]?(USDT|USDC|USD|BUSD|DAI|PERP)$/

/**
 * Strictly recognize a single token as a known symbol. Unlike `resolveSymbol`,
 * this does NOT treat arbitrary 2–6 letter words as bare stock tickers — that
 * loose fallback would flag ordinary words ("mean", "build") as symbols and
 * produce false context-mismatch blocks. Only the curated registry and explicit
 * crypto-pair forms count.
 */
function recognizeToken(token: string): { sym: string; asset: AssetClass } | undefined {
  const upper = token.trim().toUpperCase()
  if (!upper) return undefined
  const hit = SUPPORTED_SYMBOLS.find(
    (s) => s.name === upper || s.yfinance === upper || s.canonical === upper,
  )
  if (hit) return { sym: normalizeSymbol(hit.name)!, asset: kindToAssetClass(hit.kind) }
  const pair = PAIR_RE.exec(upper)
  if (pair) return { sym: normalizeSymbol(pair[1])!, asset: "crypto" }
  return undefined
}

/** Best-effort asset class for a symbol, via the supported-symbol registry. */
export function assetClassForSymbol(symbol?: string): AssetClass | undefined {
  if (!symbol) return undefined
  const resolved = resolveSymbol(symbol)
  if (resolved) return kindToAssetClass(resolved.kind)
  // Heuristic fallback for unregistered crypto pairs.
  if (/(USDT|USDC|USD|BTC|ETH|SOL|XRP|DOGE|PERP)/i.test(symbol)) return "crypto"
  return undefined
}

function normalizeAssetClass(input?: string): AssetClass | undefined {
  if (!input) return undefined
  const s = input.trim().toLowerCase()
  if (s === "crypto" || s === "cryptocurrency") return "crypto"
  if (s === "equity" || s === "equities" || s === "stock" || s === "stocks" || s === "etf") return "equity"
  return undefined
}

// ── Prompt fact parsing ─────────────────────────────────────────────────────

const INTERVAL_RE = /(\d+)\s*-?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i

/**
 * Extract the immutable request facts from a free-form user prompt. Only facts
 * the user actually stated are returned — missing fields stay undefined rather
 * than being guessed.
 */
export function parseRequestFacts(prompt: string): RequestFacts {
  const facts: RequestFacts = {}
  if (!prompt) return facts

  // Symbol: first token that strictly recognizes as a curated symbol or pair.
  const tokens = prompt.match(/[A-Za-z0-9]{2,6}(?:[\/\-][A-Za-z0-9]{2,6})?/g) ?? []
  for (const tok of tokens) {
    const recognized = recognizeToken(tok)
    if (recognized) {
      facts.requested_symbol = recognized.sym
      facts.requested_asset_class = recognized.asset
      break
    }
  }

  const im = INTERVAL_RE.exec(prompt)
  if (im) facts.requested_interval = normalizeInterval(im[0])

  if (!facts.requested_asset_class) {
    const am = /\b(crypto|cryptocurrency|equity|equities|stock|stocks|etf)\b/i.exec(prompt)
    if (am) facts.requested_asset_class = normalizeAssetClass(am[1])
  }

  return facts
}

// ── Cross-algorithm leakage detection ───────────────────────────────────────

/**
 * Inspect an algorithm/workspace name (e.g. "btc-usdt-5m-momentum") for an
 * embedded symbol or asset class that conflicts with the request. This catches
 * the leak case where the extracted data is correct (SPY) but the surrounding
 * note belongs to a foreign algo (BTC).
 */
function algoNameConflict(facts: RequestFacts, algoName?: string): boolean {
  if (!algoName) return false
  const reqSym = normalizeSymbol(facts.requested_symbol)
  const reqAsset = facts.requested_asset_class
  if (!reqSym && !reqAsset) return false

  for (const raw of algoName.split(/[-_\s.]+/)) {
    const token = raw.trim()
    if (!token) continue
    if (normalizeInterval(token)) continue // interval token, not a symbol
    const recognized = recognizeToken(token)
    if (!recognized) continue // not a recognizable symbol token
    if (reqAsset && recognized.asset !== reqAsset) return true
    if (reqSym && recognized.sym !== reqSym) return true
  }
  return false
}

/**
 * Whether a workspace slug (e.g. "spy-15m-mean-reversion.a3f8c9e2") is safe to
 * use for a request. False when the slug embeds a symbol or asset class that
 * conflicts with the request facts — the leak signature this module exists to
 * catch. A slug with no recognizable symbol tokens matches anything.
 */
export function workspaceMatchesRequest(slug: string | undefined | null, facts: RequestFacts): boolean {
  if (!slug) return false
  return !algoNameConflict(facts, slug)
}

function describeReference(identity: ArtifactIdentity): string {
  if (identity.algorithm_name) return identity.algorithm_name
  const sym = normalizeSymbol(identity.actual_symbol)
  const iv = displayInterval(normalizeInterval(identity.actual_interval))
  const asset = normalizeAssetClass(identity.actual_asset_class) ?? assetClassForSymbol(sym)
  return [sym, iv, asset].filter(Boolean).join(" ") || "an unidentified artifact"
}

function describeRequest(facts: RequestFacts): string {
  const sym = normalizeSymbol(facts.requested_symbol) ?? "?"
  const iv = displayInterval(facts.requested_interval) ?? "?"
  const asset = facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol) ?? "?"
  return `${sym} ${iv} ${asset}`
}

function blockedMessage(facts: RequestFacts, identity: ArtifactIdentity): string {
  return `BLOCKED: context mismatch — requested ${describeRequest(facts)} but subagent/artifact references ${describeReference(identity)}.`
}

/**
 * Verify a subagent result / artifact against the immutable request facts.
 *
 * - `ok`: identity is present and every comparable field matches the request.
 * - `blocked`: a field (symbol, interval, asset class, or the algorithm the
 *   artifact belongs to) contradicts the request. Carries the exact message to
 *   surface to the user. The artifact must NOT be used.
 * - `insufficient`: the artifact carries no identity metadata at all. Callers
 *   must ignore the artifact or surface a blocker — never infer relevance from
 *   prose.
 */
export function verifyIdentity(facts: RequestFacts, identity: ArtifactIdentity): VerifyResult {
  const hasAnyIdentity =
    identity.actual_symbol ||
    identity.actual_interval ||
    identity.actual_asset_class ||
    identity.algorithm_name ||
    identity.request_id ||
    identity.run_id
  if (!hasAnyIdentity) {
    return {
      ok: false,
      status: "insufficient",
      reason: "no identity metadata on artifact; cannot verify provenance",
    }
  }

  const reqSym = normalizeSymbol(facts.requested_symbol)
  const reqInterval = facts.requested_interval && normalizeInterval(facts.requested_interval)
  const reqAsset = facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol)

  const actSym = normalizeSymbol(identity.actual_symbol)
  const actInterval = normalizeInterval(identity.actual_interval)
  const actAsset =
    normalizeAssetClass(identity.actual_asset_class) ?? assetClassForSymbol(identity.actual_symbol)

  if (reqSym && actSym && reqSym !== actSym) {
    return { ok: false, status: "blocked", blocked: blockedMessage(facts, identity), reason: "symbol mismatch" }
  }
  if (reqInterval && actInterval && reqInterval !== actInterval) {
    return { ok: false, status: "blocked", blocked: blockedMessage(facts, identity), reason: "interval mismatch" }
  }
  if (reqAsset && actAsset && reqAsset !== actAsset) {
    return { ok: false, status: "blocked", blocked: blockedMessage(facts, identity), reason: "asset class mismatch" }
  }
  // The data may match the request, but the artifact/note can still belong to a
  // foreign algorithm (the observed leak). Treat that as a hard mismatch too.
  if (algoNameConflict(facts, identity.algorithm_name)) {
    return {
      ok: false,
      status: "blocked",
      blocked: blockedMessage(facts, identity),
      reason: "artifact belongs to a different algorithm",
    }
  }

  return { ok: true, status: "ok" }
}
