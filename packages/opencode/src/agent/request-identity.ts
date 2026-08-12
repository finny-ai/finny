/**
 * Request identity contract.
 *
 * Build mode launches mandatory subagents (data_extractor, news_agent) that can
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
  requested_symbols?: string[]
  requested_interval?: string
  requested_asset_class?: AssetClass
  requested_algorithm_name?: string
}

export interface RequestIdentityProposal {
  facts: RequestFacts
  status: "proposed" | "confirmed"
  confidence: number
  parser: "request_identity_v2"
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
  // Data-provider manifests and summaries sometimes annotate the tradeable
  // symbol, e.g. "BTC (BTCUSDT spot)". The identity comparison should use the
  // tradeable token, not the explanatory suffix.
  s = s.replace(/\s+\([^)]*\)\s*$/, "")
  // Exchange-qualified regional listings are complete identities. Preserve
  // the suffix; stripping punctuation here turns RELIANCE.NS into NS.
  if (/^[A-Z0-9][A-Z0-9.&-]{0,29}\.(?:NS|BO|TO|V|AS|BR|DE|L|MC|MI|PA|SW|SS|SZ|HK)$/.test(s)) {
    return s.replace(/\s+/g, "")
  }
  // Strip common quote-currency suffixes and pair separators.
  s = s.replace(/[\s_]+/g, "")
  s = s.replace(/[./\-]?(USDT|USDC|USD|PERP)$/i, "")
  s = s.replace(/[\/\-]+$/g, "")
  return s || undefined
}

/** Spoken/cardinal forms that still mean a numeric bar interval. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  "twenty-five": 25,
  twentyfive: 25,
  thirty: 30,
  forty: 40,
  "forty-five": 45,
  fortyfive: 45,
  sixty: 60,
}

function parseIntervalCount(raw: string): number | undefined {
  const digits = /^(\d+)$/.exec(raw.trim())
  if (digits) return parseInt(digits[1]!, 10)
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-")
  return WORD_NUMBERS[key] ?? WORD_NUMBERS[key.replace(/-/g, "")]
}

/** Canonical interval token: "15min"/"five-minute"/"60m"/"1hour"/"weekly" → "15m"/"5m"/"1h"/"1w". */
export function normalizeInterval(input?: string): string | undefined {
  if (!input) return undefined
  const trimmed = input.trim()
  if (/\bdaily\b/i.test(trimmed)) return "1d"
  if (/\bhourly\b/i.test(trimmed)) return "1h"
  if (/\bweekly\b/i.test(trimmed)) return "1w"

  const m =
    /^[@(]?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:[-\s]?five)?|thirty|forty(?:[-\s]?five)?|sixty)\s*-?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\s*[)]?$/i.exec(
      trimmed,
    ) ??
    /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:[-\s]?five)?|thirty|forty(?:[-\s]?five)?|sixty)\s*-?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i.exec(
      trimmed,
    )
  if (!m) return undefined
  const n = parseIntervalCount(m[1]!)
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  const unit = m[2]!.toLowerCase()
  if (unit === "w" || unit.startsWith("week")) return n === 1 ? "1w" : `${n}w`
  if (unit === "h" || unit.startsWith("hour") || unit.startsWith("hr")) return `${n}h`
  if (unit === "d" || unit.startsWith("day")) return `${n}d`
  // minutes / m / min / mins — never months (months is not in the unit alt list)
  if (unit === "m" || unit.startsWith("min")) {
    if (n % 60 === 0 && n >= 60) return `${n / 60}h`
    return `${n}m`
  }
  return undefined
}

/** Render a canonical interval for human-facing messages: "15m" → "15min". */
function displayInterval(canonical?: string): string | undefined {
  if (!canonical) return undefined
  const m = /^(\d+)([mhdw])$/.exec(canonical)
  if (!m) return canonical
  const n = m[1]
  switch (m[2]) {
    case "m":
      return `${n}min`
    case "h":
      return `${n}h`
    case "w":
      return n === "1" ? "weekly" : `${n}w`
    default:
      return `${n}d`
  }
}

function kindToAssetClass(kind: string): AssetClass {
  return kind === "crypto" ? "crypto" : "equity"
}

const PAIR_RE = /^([A-Z0-9]{2,6})[-/]?(USDT|USDC|USD|BUSD|DAI|PERP)$/
const REGIONAL_TICKER_RE = /^[A-Z0-9][A-Z0-9.&-]{0,29}\.(?:NS|BO|TO|V|AS|BR|DE|L|MC|MI|PA|SW|SS|SZ|HK)$/
const TICKERISH_RE =
  /^(?:[A-Z0-9]{1,6}(?:[\/\-][A-Z0-9]{1,6})?|[A-Z0-9][A-Z0-9.&-]{0,29}\.(?:NS|BO|TO|V|AS|BR|DE|L|MC|MI|PA|SW|SS|SZ|HK))$/
const NON_TRADEABLE_ACRONYMS = new Set([
  "APAC",
  "CPI",
  "EMEA",
  "EU",
  "FED",
  "FOMC",
  "GDP",
  "ISM",
  "NFP",
  "PCE",
  "UK",
  "US",
  "USA",
  // Exchange/market names are not tradable instruments. A regional-market
  // request without an exact listing must remain unresolved and ask for one
  // (for example, RELIANCE.NS), rather than binding to "NSE" or "TSX".
  "NSE",
  "BSE",
  "TSX",
  "TSXV",
  "LSE",
  "SSE",
  "SZSE",
  "HKEX",
])

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
  const hit = SUPPORTED_SYMBOLS.find((s) => s.name === upper || s.yfinance === upper || s.canonical === upper)
  if (hit) return { sym: normalizeSymbol(hit.name)!, asset: kindToAssetClass(hit.kind) }
  const pair = PAIR_RE.exec(upper)
  if (pair) return { sym: normalizeSymbol(pair[1])!, asset: "crypto" }
  return undefined
}

function cleanSymbolToken(token: string): string {
  return token.trim().replace(/^[`"'([{]+|[`"',.;:!?)}\]]+$/g, "")
}

function recognizeExplicitSymbol(
  token: string,
  opts: { allowUnknown: boolean; requireUppercaseForUnknown?: boolean; rejectAmbiguousUnknown?: boolean },
): { sym: string; asset: AssetClass } | undefined {
  const cleaned = cleanSymbolToken(token)
  if (!cleaned) return undefined

  const strict = recognizeToken(cleaned)
  if (strict) return strict

  const regional = cleaned.toUpperCase()
  if (REGIONAL_TICKER_RE.test(regional)) return { sym: regional, asset: "equity" }

  if (!opts.allowUnknown) return undefined
  if (opts.requireUppercaseForUnknown && cleaned !== cleaned.toUpperCase()) return undefined
  const upper = cleaned.toUpperCase()
  if (!TICKERISH_RE.test(upper) || NON_TRADEABLE_ACRONYMS.has(upper)) return undefined
  if (opts.rejectAmbiguousUnknown && (AMBIGUOUS_TICKER_TOKENS.has(upper) || TICKER_STOPWORDS.has(upper))) {
    return undefined
  }

  const resolved = resolveSymbol(upper)
  if (!resolved) return undefined
  return { sym: normalizeSymbol(resolved.name)!, asset: kindToAssetClass(resolved.kind) }
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

function normalizedRequestedSymbols(facts: RequestFacts): string[] {
  const symbols = facts.requested_symbols?.length
    ? facts.requested_symbols
    : facts.requested_symbol
      ? [facts.requested_symbol]
      : []
  return symbols.map((symbol) => normalizeSymbol(symbol)).filter((symbol): symbol is string => Boolean(symbol))
}

// ── Prompt fact parsing ─────────────────────────────────────────────────────

const INTERVAL_COUNT = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:[-\s]?five)?|thirty|forty(?:[-\s]?five)?|sixty)`
const INTERVAL_UNIT = String.raw`(?:minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)`
// The leading boundary is essential for spoken counts: without it, ordinary
// words such as "extend" contain the substring "ten" + "d" and are silently
// misread as a 10-day bar interval.
const INTERVAL_RE = new RegExp(String.raw`\b(${INTERVAL_COUNT})\s*-?\s*(${INTERVAL_UNIT})\b`, "gi")
const INTERVAL_TOKEN = String.raw`${INTERVAL_COUNT}\s*-?\s*${INTERVAL_UNIT}`
// Labels that mark the *request bar* rather than an indicator window.
const EXPLICIT_INTERVAL_BEFORE_RE =
  /\b(?:bar\s+size|bar\s+interval|bar\s+period|candle\s+size|candle\s+period|cadence|every|frequency|interval|resolution|sampling\s+frequency|timeframe|time-frame)\s*(?::|=|is|of)?\s*$/i
// Accept both "1h or 4h bars" and "1h, 4h, or 1d bars" as explicit bar alternatives.
const EXPLICIT_INTERVAL_AFTER_RE = new RegExp(
  String.raw`^\s*(?:(?:(?:,\s*|\s+(?:or|and)\s+|\/\s*)+${INTERVAL_TOKEN}\s*)+)?(?:bar|bars|candle|candles|chart|charts|cadence|data|frequency|interval|market\s+data|ohlc|ohlcv|price|prices|resolution|timeframe|time-frame)\b`,
  "i",
)
// Word-boundary feature tokens so "small-cap" / "smart beta" are not treated as SMA/window horizons.
const FEATURE_HORIZON_AFTER_RE =
  /^\s*(?:[-–—]\s*)?(?:(?:simple|exponential|relative\s+strength|average\s+true\s+range)\s+)?(?:\b(?:adx|atr|bollinger|ema|indicator|lookback|macd|ma|period|rsi|sma|stdev|volatility|window|wma)\b|moving\s+average|standard\s+deviation|vol\s+filter|rolling\b)/i
const FEATURE_HORIZON_BEFORE_RE =
  /(?:\b(?:adx|atr|bollinger|ema|macd|ma|rsi|sma|stdev|volatility|window|wma)\b|moving\s+average|standard\s+deviation|rolling|lookback(?:\s+period)?|look\s*back(?:\s+period)?)\s*(?:\(|of|:|=|is)?\s*$/i
// Durations ("last 6 months", "over 3 months") are not bar intervals.
const DURATION_CONTEXT_RE = /\b(?:last|past|previous|next|over|for|during|within|across)\s*$/i
const BARE_INTERVAL_RE = /\b(daily|hourly|weekly)\b/gi
const BARE_INTERVAL_TIMEFRAME_CONTEXT_RE =
  /\b(?:bar|bars|candle|candles|chart|charts|cadence|crossover|data|frequency|interval|market\s+data|ohlc|ohlcv|price|prices|resolution|strategy|timeframe|time-frame)\b/i
const BARE_INTERVAL_RISK_CONTEXT_RE =
  /\b(?:cap|caps|drawdown|limit|limits|loss|losses|max|maximum|min|minimum|p&l|pnl|profit|profits|return|returns|risk|risking|stop|stops|target|targets|vol|volatility)\b/i
const REQUESTED_ALGORITHM_NAME_RES = [
  /\b(?:requested_algorithm_name|algorithm\s+name|strategy\s+name)\s*[:=]\s*[`"']?([a-z0-9][a-z0-9._-]{2,})[`"']?/i,
  /\b(?:name\s+it|named|called)\s+[`"']?([a-z0-9][a-z0-9._-]{2,})[`"']?/i,
  /\b(?:existing|current|active|saved)?\s*(?:algorithm|algo|strategy)\s+([`"'])([a-z0-9][a-z0-9._-]{2,})\1/i,
]
const EXPLICIT_SYMBOL_RES: Array<{
  re: RegExp
  score: number
  allowUnknown: boolean
  requireUppercaseForUnknown?: boolean
  rejectAmbiguousUnknown?: boolean
  capture?: number
}> = [
  {
    re: /\b([A-Za-z0-9][A-Za-z0-9.&-]{0,29}\.(?:NS|BO|TO|V|AS|BR|DE|L|MC|MI|PA|SW|SS|SZ|HK))\b/gi,
    score: 140,
    allowUnknown: true,
  },
  {
    // Exchange-qualified Canadian tickers must bind to the ticker, not the
    // exchange code (for example, TSXV:PNG → PNG).
    re: /\b(?:NSE|BSE|TSXV|TSX|CSE|XETRA|LSE|SSE|SZSE|HKEX|NASDAQ|NYSE|AMEX)\s*:\s*([A-Za-z0-9]{1,30}(?:[\/\-][A-Za-z0-9]{1,8})?)/gi,
    score: 130,
    allowUnknown: true,
    requireUppercaseForUnknown: true,
  },
  {
    re: /\b(?:requested_symbol|requested\s+symbol|symbol|ticker)\s*[:=]\s*[`"']?([A-Za-z0-9]{1,6}(?:[\/\-][A-Za-z0-9]{1,6})?)/gi,
    score: 120,
    allowUnknown: true,
  },
  {
    re: /\buse\s+[`"']?([A-Za-z0-9]{1,6}(?:[\/\-][A-Za-z0-9]{1,6})?)[`"']?\s+as\s+(?:the\s+)?(?:traded\s+)?(?:symbol|ticker|vehicle|market|instrument)\b/gi,
    score: 115,
    allowUnknown: true,
    requireUppercaseForUnknown: true,
  },
  {
    re: /\b(?:(?:instead\s+of|rather\s+than|avoid|not)\s+[`"']?([A-Za-z0-9]{1,6}(?:[\/\-][A-Za-z0-9]{1,6})?)[`"']?|do\s+not\s+use\s+[`"']?([A-Za-z0-9]{1,6}(?:[\/\-][A-Za-z0-9]{1,6})?)[`"']?)[^.?!;]{0,80}?\buse\s+[`"']?([A-Za-z0-9]{1,6}(?:[\/\-][A-Za-z0-9]{1,6})?)[`"']?\b/gi,
    score: 180,
    allowUnknown: true,
    requireUppercaseForUnknown: true,
    capture: 3,
  },
  {
    re: /\b(?:traded\s+symbol|target\s+(?:symbol|ticker|vehicle)|market|instrument)\s*(?:is|as|=|:)?\s*[`"']?([A-Za-z0-9]{1,6}(?:[\/\-][A-Za-z0-9]{1,6})?)/gi,
    score: 110,
    allowUnknown: true,
    requireUppercaseForUnknown: true,
  },
  {
    re: /\b(?:trade|backtest|test|build|run|extract|fetch|load|download|retrieve)\s+(?:historical\s+)?(?:data\s+for\s+|on\s+|for\s+|against\s+)?[`"']?([A-Za-z0-9]{1,6}(?:[\/\-][A-Za-z0-9]{1,6})?)\b/gi,
    score: 90,
    allowUnknown: true,
    requireUppercaseForUnknown: true,
    // Verb-adjacent prose is the least reliable signal, so indicator/broker
    // acronyms ("build ... for IBKR", "backtest RSI mean-reversion") are
    // rejected here while keyword-anchored patterns above still accept them.
    rejectAmbiguousUnknown: true,
  },
]

function requestedAlgorithmName(prompt: string): string | undefined {
  for (const re of REQUESTED_ALGORITHM_NAME_RES) {
    const match = re.exec(prompt)
    const name = match?.[2] ?? match?.[1]
    if (name) return name.replace(/[.,;:!?]+$/g, "")
  }
  return undefined
}

function promptWords(prompt: string): string[] {
  return prompt.match(/[A-Za-z0-9$%&]+/g) ?? []
}

function isRejectedComparisonContext(prompt: string, index: number): boolean {
  const before = prompt.slice(Math.max(0, index - 96), index)
  const nearbyBefore = prompt.slice(Math.max(0, index - 40), index)
  const after = prompt.slice(index, index + 48)
  return (
    /\b(?:stronger|better|cleaner|sharper|different|more\s+\w+)\b[^.?!,;]{0,80}\bthan\b/i.test(before) ||
    /\b(?:instead\s+of|rather\s+than|not|avoid|baseline|benchmark|broad|compared\s+to|versus|vs\.?)\b/i.test(
      nearbyBefore,
    ) ||
    /^\W*(?:baseline|benchmark)\b/i.test(after)
  )
}

function explicitSymbolFromPrompt(prompt: string): { sym: string; asset: AssetClass } | undefined {
  const regionalAlias = /\b(NSE|BSE|TSXV|TSX|CSE|XETRA|LSE|SSE|SZSE|HKEX)\s*:\s*([A-Za-z0-9][A-Za-z0-9.&-]{0,29})/i.exec(prompt)
  if (regionalAlias) {
    const suffix: Record<string, string> = { NSE: "NS", BSE: "BO", TSXV: "V", TSX: "TO", CSE: "TO", XETRA: "DE", LSE: "L", SSE: "SS", SZSE: "SZ", HKEX: "HK" }
    const sym = `${regionalAlias[2].toUpperCase()}.${suffix[regionalAlias[1].toUpperCase()]}`
    return { sym, asset: "equity" }
  }
  const candidates: Array<{ index: number; score: number; symbol: { sym: string; asset: AssetClass } }> = []
  for (const pattern of EXPLICIT_SYMBOL_RES) {
    pattern.re.lastIndex = 0
    for (const match of prompt.matchAll(pattern.re)) {
      const raw = match[pattern.capture ?? 1]
      if (!raw) continue
      const symbol = recognizeExplicitSymbol(raw, {
        allowUnknown: pattern.allowUnknown,
        requireUppercaseForUnknown: pattern.requireUppercaseForUnknown,
        rejectAmbiguousUnknown: pattern.rejectAmbiguousUnknown,
      })
      if (!symbol) continue
      const index = match.index ?? 0
      candidates.push({
        index,
        score: pattern.score - (isRejectedComparisonContext(prompt, index) ? 80 : 0),
        symbol,
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  return candidates[0]?.score && candidates[0].score > 0 ? candidates[0].symbol : undefined
}

function looseSymbolFromPrompt(prompt: string): { sym: string; asset: AssetClass } | undefined {
  const tokens = prompt.match(/[A-Za-z0-9]{2,6}(?:[\/\-][A-Za-z0-9]{2,6})?/g) ?? []
  for (const tok of tokens) {
    const index = prompt.indexOf(tok)
    if (index >= 0 && isRejectedComparisonContext(prompt, index)) continue
    const recognized = recognizeToken(tok)
    if (recognized) return recognized

    // Terse prompts often arrive as strategy slugs, e.g. "spy-5m-momentum".
    // The regex above sees "spy-5m" as one token, which is not a market pair.
    // Fall back to strict recognition of each slug segment without enabling
    // arbitrary ticker guesses.
    for (const part of tok.split(/[\/\-_]+/)) {
      const segment = recognizeToken(part)
      if (segment) return segment
    }
  }
  return undefined
}

function nextToken(text: string): string | undefined {
  const match = /^\s*[`"'([]*([A-Za-z0-9][A-Za-z0-9./_-]*)/.exec(text)
  return match?.[1]
}

function bareIntervalNearSymbol(before: string, after: string): boolean {
  // "on daily AAPL" / "AAPL daily" — bare cadence next to a known ticker is bar identity.
  const afterTok = nextToken(after)
  if (afterTok && recognizeToken(afterTok)) return true
  const previous = before.match(/([A-Za-z0-9][A-Za-z0-9./_-]*)\s*$/)?.[1]
  return Boolean(previous && recognizeToken(previous))
}

function bareIntervalFromPrompt(prompt: string): string | undefined {
  BARE_INTERVAL_RE.lastIndex = 0
  for (const match of prompt.matchAll(BARE_INTERVAL_RE)) {
    const word = match[1]
    const index = match.index ?? 0
    const before = prompt.slice(Math.max(0, index - 40), index)
    const after = prompt.slice(index + match[0].length, index + match[0].length + 56)
    const localContext = `${before} ${after}`
    const immediateContext = [
      ...promptWords(before)
        .slice(-2)
        .map((w) => w.toLowerCase()),
      ...promptWords(after)
        .slice(0, 2)
        .map((w) => w.toLowerCase()),
    ].join(" ")

    if (BARE_INTERVAL_RISK_CONTEXT_RE.test(immediateContext)) continue

    if (BARE_INTERVAL_TIMEFRAME_CONTEXT_RE.test(localContext)) return normalizeInterval(word)
    if (bareIntervalNearSymbol(before, after)) return normalizeInterval(word)

    // Keep terse prompts like "SOL daily" working without treating common
    // risk phrases in full sentences as interval requests.
    if (promptWords(prompt).length <= 4) return normalizeInterval(word)
  }
  return undefined
}

/**
 * Distinguish the request's bar interval from feature horizons. Financial
 * prompts commonly mix both ("daily bars with a 20-day SMA"); selecting the
 * first interval-shaped token lets the indicator horizon corrupt request
 * identity. Explicit bar/timeframe language wins, feature windows are ignored,
 * and compatible implicit forms such as "SPY 15-minute strategy" remain valid.
 */
function isExplicitBarInterval(before: string, after: string): boolean {
  if (EXPLICIT_INTERVAL_BEFORE_RE.test(before) || EXPLICIT_INTERVAL_AFTER_RE.test(after)) return true
  // Parenthetical / at-sign / dotted compact forms: "SPY (15m)", "SPY @ 5m".
  if (/[@(]\s*$/.test(before) && /^\s*[,;).]/.test(after)) return true
  if (/@\s*$/.test(before)) return true
  return false
}

function isFeatureHorizon(before: string, after: string): boolean {
  return FEATURE_HORIZON_BEFORE_RE.test(before) || FEATURE_HORIZON_AFTER_RE.test(after)
}

function isDurationContext(before: string, after: string): boolean {
  // Only reject when the duration cue is *adjacent* to this token.
  // "15-minute ... over 3 months" must keep 15m; "over 3 months" alone must not invent a bar.
  if (DURATION_CONTEXT_RE.test(before)) return true
  // "3-month window" / "6 months of data" immediately after the number+unit.
  if (/^\s*(?:-?\s*)?(?:month|months|mo)\b/i.test(after)) return true
  return false
}

function intervalFromPrompt(prompt: string): string | undefined {
  const candidates: Array<{ index: number; score: number; interval: string }> = []
  INTERVAL_RE.lastIndex = 0
  for (const match of prompt.matchAll(INTERVAL_RE)) {
    const index = match.index ?? 0
    const before = prompt.slice(Math.max(0, index - 64), index)
    const after = prompt.slice(index + match[0].length, index + match[0].length + 80)
    if (isDurationContext(before, after)) continue
    const explicit = isExplicitBarInterval(before, after)
    const nearSymbol = bareIntervalNearSymbol(before, after)
    // Explicit bar/timeframe labels win over nearby feature-horizon words
    // ("timeframe: 15-minute volatility breakout" is still 15m bars).
    if (!explicit && !nearSymbol && isFeatureHorizon(before, after)) continue

    const interval = normalizeInterval(match[0])
    if (!interval) continue
    const nearbyTimeframe = BARE_INTERVAL_TIMEFRAME_CONTEXT_RE.test(`${before.slice(-32)} ${after.slice(0, 56)}`)
    const score = explicit ? 300 : nearbyTimeframe ? 200 : nearSymbol ? 150 : 100
    candidates.push({ index, score, interval })
  }

  // Compact parenthetical / @ tokens that INTERVAL_RE may not own when glued:
  // "SPY(15m)", "SPY@5m".
  for (const match of prompt.matchAll(
    /[@(]\s*(\d+)\s*-?\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*\)?/gi,
  )) {
    const index = match.index ?? 0
    const interval = normalizeInterval(match[0].replace(/^[@(]/, "").replace(/\)$/, ""))
    if (!interval) continue
    candidates.push({ index, score: 280, interval })
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  return candidates[0]?.interval ?? bareIntervalFromPrompt(prompt)
}

const EXPLICIT_TICKER_RE = /^[A-Z][A-Z0-9.]{0,5}$/
/**
 * Acronyms that are far more likely to be indicators, brokers, or order jargon
 * than traded tickers when they appear in unlabeled prose ("for IBKR, RSI
 * mean-reversion", "set TP, SL"). They stay valid in keyword-anchored forms
 * ("symbols: IBKR, RSI" or "ticker: RSI"), where the user is explicit.
 */
const AMBIGUOUS_TICKER_TOKENS = new Set([
  "ADX",
  "ATR",
  "BB",
  "CCI",
  "DCA",
  "DEMA",
  "DMI",
  "EMA",
  "IB",
  "IBKR",
  "MACD",
  "MFI",
  "OBV",
  "PSAR",
  "ROC",
  "RSI",
  "SAR",
  "SL",
  "SMA",
  "STOCH",
  "TEMA",
  "TP",
  "TWAP",
  "VWAP",
  "WMA",
])
const TICKER_STOPWORDS = new Set([
  "API",
  "APAC",
  "CRUCIBLE",
  "COUNTS",
  "CPI",
  "CSV",
  "DD",
  "ETF",
  "ETFS",
  "EU",
  "EMEA",
  "FED",
  "FINNY",
  "FOMC",
  "FX",
  "GDP",
  "ISM",
  "JSON",
  "LEAN",
  "NFP",
  "NO",
  "OHLCV",
  "PCE",
  "PCT",
  "QC",
  "SEC",
  "THE",
  "URL",
  "UK",
  "US",
  "USA",
  "USD",
  "YES",
])

function cleanTickerToken(token: string): string | undefined {
  const stripped = token.trim().replace(/^["'`\[]+|["'`\].:;!?]+$/g, "")
  if (/[a-z]/.test(stripped)) return undefined
  const cleaned = stripped.toUpperCase()
  if (!EXPLICIT_TICKER_RE.test(cleaned)) return undefined
  if (TICKER_STOPWORDS.has(cleaned)) return undefined
  return cleaned
}

function parseTickerList(raw: string): string[] {
  const parts = raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/\s*,\s*/)
    .map(cleanTickerToken)
    .filter((symbol): symbol is string => Boolean(symbol))
  return parts.filter((symbol, index) => parts.indexOf(symbol) === index)
}

function parseExplicitUniverse(prompt: string): { list: string[]; keyed: boolean } | undefined {
  const keyed =
    /\b(?:symbols?|tickers?|universe|basket|portfolio|stocks?)\b\s*(?:is|are|=|:|of|for|including|include|linked)?\s*(\[[^\]\n]+\]|\b[A-Z][A-Z0-9.]{0,5}\b(?:\s*,\s*\b[A-Z][A-Z0-9.]{0,5}\b){1,})/i.exec(
      prompt,
    )
  if (keyed?.[1]) {
    const list = parseTickerList(keyed[1])
    if (list.length > 0) return { list, keyed: true }
  }

  // Unlabeled comma lists in prose are weak evidence: "for IBKR, RSI
  // mean-reversion" names a broker and an indicator, not a universe. Only
  // tokens that survive the ambiguity filter count here.
  const bare = /(\b[A-Z][A-Z0-9.]{0,5}\b(?:\s*,\s*\b[A-Z][A-Z0-9.]{0,5}\b){1,})/i.exec(prompt)?.[1]
  if (bare) {
    const list = parseTickerList(bare).filter((symbol) => !AMBIGUOUS_TICKER_TOKENS.has(symbol))
    if (list.length > 0) return { list, keyed: false }
  }

  const single =
    /\b(?:symbol|ticker|stock)\b\s*(?:is|=|:)?\s*([A-Z][A-Z0-9.]{0,5})\b/.exec(prompt)?.[1] ??
    (/(\bbuild\b|\bstrategy\b|\bbacktest\b|\bportfolio\b|\bstock\b|\bequity\b|\b\d+\s*(?:m(?:in(?:ute)?s?)?|h(?:ours?|rs?)?|d(?:ays?)?|w(?:eeks?)?)\b)/i.test(
      prompt,
    )
      ? Array.from(prompt.matchAll(/\b([A-Z][A-Z0-9.]{1,5})\b/g), (match) => cleanTickerToken(match[1]!)).find(
          (token) => Boolean(token) && !AMBIGUOUS_TICKER_TOKENS.has(token!),
        )
      : undefined)
  const cleaned = single ? cleanTickerToken(single) : undefined
  return cleaned ? { list: [cleaned], keyed: false } : undefined
}

/**
 * Extract the immutable request facts from a free-form user prompt. Only facts
 * the user actually stated are returned — missing fields stay undefined rather
 * than being guessed.
 */
export function parseRequestFacts(prompt: string): RequestFacts {
  const facts: RequestFacts = {}
  if (!prompt) return facts

  const universe = parseExplicitUniverse(prompt)
  const explicitSymbol = explicitSymbolFromPrompt(prompt)
  const universeList = universe?.list ?? []
  // An unkeyed comma list is weak evidence; it only stands as the universe
  // when nothing explicit contradicts it. "for IBKR, RSI mean-reversion ...
  // requested_symbol=SPY" must resolve to SPY, while "trade AAPL, MSFT daily"
  // keeps its list because the explicit symbol is part of it.
  const explicitInUniverse = explicitSymbol
    ? universeList.map((s) => normalizeSymbol(s)).includes(explicitSymbol.sym)
    : false
  if (universeList.length > 1 && (universe!.keyed || !explicitSymbol || explicitInUniverse)) {
    facts.requested_symbols = universeList
  }

  if (!facts.requested_symbol && !facts.requested_symbols?.length) {
    const fallbackSymbol = universeList.length === 1 ? universeList[0] : undefined
    const symbol =
      explicitSymbol ??
      (fallbackSymbol
        ? {
            sym: normalizeSymbol(fallbackSymbol)!,
            asset: assetClassForSymbol(fallbackSymbol) ?? "equity",
          }
        : undefined) ??
      looseSymbolFromPrompt(prompt)
    if (symbol) {
      facts.requested_symbol = symbol.sym
      facts.requested_asset_class = symbol.asset
    }
  }

  facts.requested_interval = intervalFromPrompt(prompt)

  const name = requestedAlgorithmName(prompt)
  if (name) facts.requested_algorithm_name = name

  if (!facts.requested_asset_class) {
    const am = /\b(crypto|cryptocurrency|equity|equities|stock|stocks|etf)\b/i.exec(prompt)
    if (am) facts.requested_asset_class = normalizeAssetClass(am[1])
  }
  if (!facts.requested_asset_class && facts.requested_symbol) {
    facts.requested_asset_class = assetClassForSymbol(facts.requested_symbol)
  }
  if (!facts.requested_asset_class && facts.requested_symbols?.length) facts.requested_asset_class = "equity"

  return facts
}

/**
 * Parser output is explicitly classified as a proposal. A symbol becomes
 * confirmed only when the user's text contains the exact structured/uppercase
 * token; delegated instrument selection therefore stays unresolved.
 */
export function parseRequestIdentityProposal(prompt: string): RequestIdentityProposal {
  const facts = parseRequestFacts(prompt)
  const symbols = facts.requested_symbols?.length
    ? facts.requested_symbols
    : facts.requested_symbol
      ? [facts.requested_symbol]
      : []
  if (symbols.length === 0) {
    return { facts, status: "proposed", confidence: 0, parser: "request_identity_v2" }
  }
  const exact = symbols.every((symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(prompt)
  })
  return {
    facts,
    status: exact ? "confirmed" : "proposed",
    confidence: exact ? 1 : 0.5,
    parser: "request_identity_v2",
  }
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
  const reqSyms = normalizedRequestedSymbols(facts)
  const reqAsset = facts.requested_asset_class
  if (reqSyms.length === 0 && !reqSym && !reqAsset) return false

  for (const raw of algoName.split(/[-_\s.]+/)) {
    const token = raw.trim()
    if (!token) continue
    if (normalizeInterval(token)) continue // interval token, not a symbol
    const recognized = recognizeToken(token)
    if (!recognized) continue // not a recognizable symbol token
    if (reqAsset && recognized.asset !== reqAsset) return true
    if (reqSyms.length > 0 && !reqSyms.includes(recognized.sym)) return true
    if (reqSyms.length === 0 && reqSym && recognized.sym !== reqSym) return true
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
  const symbols = normalizedRequestedSymbols(facts)
  const sym = symbols.length > 0 ? symbols.join(",") : (normalizeSymbol(facts.requested_symbol) ?? "?")
  const iv = displayInterval(facts.requested_interval) ?? "?"
  const asset = facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol ?? symbols[0]) ?? "?"
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
  const reqSyms = normalizedRequestedSymbols(facts)
  const reqInterval = facts.requested_interval && normalizeInterval(facts.requested_interval)
  const reqAsset = facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol ?? reqSyms[0])

  const actSym = normalizeSymbol(identity.actual_symbol)
  const actInterval = normalizeInterval(identity.actual_interval)
  const actAsset = normalizeAssetClass(identity.actual_asset_class) ?? assetClassForSymbol(identity.actual_symbol)

  if (reqSyms.length > 0 && actSym && !reqSyms.includes(actSym)) {
    return { ok: false, status: "blocked", blocked: blockedMessage(facts, identity), reason: "symbol mismatch" }
  }
  if (reqSyms.length === 0 && reqSym && actSym && reqSym !== actSym) {
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
