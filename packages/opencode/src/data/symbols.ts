/**
 * Symbol registry. Two roles:
 *
 * 1. **Curated featured list** — the symbols Finny advertises in prompts /
 *    welcome dialog / examples. Kept tight and maintainable.
 *
 * 2. **Permissive resolver** — `resolveSymbol` accepts ANY plausible ticker,
 *    not just curated ones. Curated symbols return rich metadata; unknown
 *    tickers (think: less popular ETFs, smaller-cap stocks, exotic crypto
 *    pairs) are returned with `unknown: true` so the data-fetch layer can
 *    still try them against yfinance / Alpaca / Binance instead of failing
 *    up front. This avoids the rage-quit case where the user asks for a
 *    real ticker and Finny refuses just because it isn't on a hand-rolled
 *    list.
 *
 * Adding a symbol to {@link SUPPORTED_SYMBOLS} makes it appear in every
 * prompt's `<supported_markets/>` block and in the welcome dialog.
 */
export type SymbolKind = "crypto" | "stock" | "etf"

export interface SupportedSymbol {
  /** User-facing canonical name (e.g. "BTC", "AAPL"). */
  name: string
  kind: SymbolKind
  /** yfinance-compatible ticker (e.g. "BTC-USD", "AAPL"). */
  yfinance: string
  /** Strategy/config-form symbol (e.g. "BTC/USD", "AAPL"). */
  canonical: string
  /** True when the symbol was synthesized by the permissive resolver, not in the curated list. */
  unknown?: boolean
}

// Featured list. Crypto pairs are USD-quoted (Alpaca-style; Binance USDT
// pairs are normalized to USD by the resolver). Stocks/ETFs use their plain
// US ticker. Keep this list reasonable in size — anything not here still
// works via the permissive resolver below.
export const SUPPORTED_SYMBOLS: readonly SupportedSymbol[] = [
  // ──────── Crypto (Alpaca + Binance USD-quoted pairs) ────────
  { name: "BTC", kind: "crypto", yfinance: "BTC-USD", canonical: "BTC/USD" },
  { name: "ETH", kind: "crypto", yfinance: "ETH-USD", canonical: "ETH/USD" },
  { name: "SOL", kind: "crypto", yfinance: "SOL-USD", canonical: "SOL/USD" },
  { name: "XRP", kind: "crypto", yfinance: "XRP-USD", canonical: "XRP/USD" },
  { name: "ADA", kind: "crypto", yfinance: "ADA-USD", canonical: "ADA/USD" },
  { name: "DOGE", kind: "crypto", yfinance: "DOGE-USD", canonical: "DOGE/USD" },
  { name: "AVAX", kind: "crypto", yfinance: "AVAX-USD", canonical: "AVAX/USD" },
  { name: "LINK", kind: "crypto", yfinance: "LINK-USD", canonical: "LINK/USD" },
  { name: "MATIC", kind: "crypto", yfinance: "MATIC-USD", canonical: "MATIC/USD" },
  { name: "DOT", kind: "crypto", yfinance: "DOT-USD", canonical: "DOT/USD" },
  { name: "ATOM", kind: "crypto", yfinance: "ATOM-USD", canonical: "ATOM/USD" },
  { name: "LTC", kind: "crypto", yfinance: "LTC-USD", canonical: "LTC/USD" },
  { name: "BCH", kind: "crypto", yfinance: "BCH-USD", canonical: "BCH/USD" },
  { name: "UNI", kind: "crypto", yfinance: "UNI-USD", canonical: "UNI/USD" },
  { name: "AAVE", kind: "crypto", yfinance: "AAVE-USD", canonical: "AAVE/USD" },
  { name: "ARB", kind: "crypto", yfinance: "ARB-USD", canonical: "ARB/USD" },
  { name: "OP", kind: "crypto", yfinance: "OP-USD", canonical: "OP/USD" },
  { name: "SUI", kind: "crypto", yfinance: "SUI-USD", canonical: "SUI/USD" },

  // ──────── Stocks (large-cap + popular movers) ────────
  { name: "AAPL", kind: "stock", yfinance: "AAPL", canonical: "AAPL" },
  { name: "MSFT", kind: "stock", yfinance: "MSFT", canonical: "MSFT" },
  { name: "GOOGL", kind: "stock", yfinance: "GOOGL", canonical: "GOOGL" },
  { name: "GOOG", kind: "stock", yfinance: "GOOG", canonical: "GOOG" },
  { name: "AMZN", kind: "stock", yfinance: "AMZN", canonical: "AMZN" },
  { name: "META", kind: "stock", yfinance: "META", canonical: "META" },
  { name: "NVDA", kind: "stock", yfinance: "NVDA", canonical: "NVDA" },
  { name: "TSLA", kind: "stock", yfinance: "TSLA", canonical: "TSLA" },
  { name: "AMD", kind: "stock", yfinance: "AMD", canonical: "AMD" },
  { name: "INTC", kind: "stock", yfinance: "INTC", canonical: "INTC" },
  { name: "AVGO", kind: "stock", yfinance: "AVGO", canonical: "AVGO" },
  { name: "ORCL", kind: "stock", yfinance: "ORCL", canonical: "ORCL" },
  { name: "CRM", kind: "stock", yfinance: "CRM", canonical: "CRM" },
  { name: "NFLX", kind: "stock", yfinance: "NFLX", canonical: "NFLX" },
  { name: "PLTR", kind: "stock", yfinance: "PLTR", canonical: "PLTR" },
  { name: "COIN", kind: "stock", yfinance: "COIN", canonical: "COIN" },
  { name: "MSTR", kind: "stock", yfinance: "MSTR", canonical: "MSTR" },
  { name: "DJT", kind: "stock", yfinance: "DJT", canonical: "DJT" },
  { name: "JPM", kind: "stock", yfinance: "JPM", canonical: "JPM" },
  { name: "BAC", kind: "stock", yfinance: "BAC", canonical: "BAC" },
  { name: "GS", kind: "stock", yfinance: "GS", canonical: "GS" },
  { name: "BRK-B", kind: "stock", yfinance: "BRK-B", canonical: "BRK-B" },
  { name: "WMT", kind: "stock", yfinance: "WMT", canonical: "WMT" },
  { name: "XOM", kind: "stock", yfinance: "XOM", canonical: "XOM" },
  { name: "UNH", kind: "stock", yfinance: "UNH", canonical: "UNH" },
  { name: "JNJ", kind: "stock", yfinance: "JNJ", canonical: "JNJ" },
  { name: "V", kind: "stock", yfinance: "V", canonical: "V" },
  { name: "MA", kind: "stock", yfinance: "MA", canonical: "MA" },

  // ──────── ETFs (broad indices + popular sector / leveraged plays) ────────
  { name: "SPY", kind: "etf", yfinance: "SPY", canonical: "SPY" },
  { name: "QQQ", kind: "etf", yfinance: "QQQ", canonical: "QQQ" },
  { name: "IWM", kind: "etf", yfinance: "IWM", canonical: "IWM" },
  { name: "DIA", kind: "etf", yfinance: "DIA", canonical: "DIA" },
  { name: "VOO", kind: "etf", yfinance: "VOO", canonical: "VOO" },
  { name: "VTI", kind: "etf", yfinance: "VTI", canonical: "VTI" },
  { name: "TQQQ", kind: "etf", yfinance: "TQQQ", canonical: "TQQQ" },
  { name: "SQQQ", kind: "etf", yfinance: "SQQQ", canonical: "SQQQ" },
  { name: "SOXL", kind: "etf", yfinance: "SOXL", canonical: "SOXL" },
  { name: "ARKK", kind: "etf", yfinance: "ARKK", canonical: "ARKK" },
  { name: "GLD", kind: "etf", yfinance: "GLD", canonical: "GLD" },
  { name: "SLV", kind: "etf", yfinance: "SLV", canonical: "SLV" },
  { name: "USO", kind: "etf", yfinance: "USO", canonical: "USO" },
  { name: "TLT", kind: "etf", yfinance: "TLT", canonical: "TLT" },
  { name: "HYG", kind: "etf", yfinance: "HYG", canonical: "HYG" },
] as const

export function listByKind(kind: SymbolKind): readonly SupportedSymbol[] {
  return SUPPORTED_SYMBOLS.filter((s) => s.kind === kind)
}

// Most common stable / quote currencies we strip when normalizing pair forms.
const QUOTE_CURRENCIES = ["USD", "USDT", "USDC", "BUSD", "DAI"]

// Bare crypto bases that aren't in the curated SUPPORTED_SYMBOLS list but
// are common enough that bare-ticker resolution should treat them as crypto,
// not as stock. Without this, `PEPE` / `SHIB` etc. would match the
// stock-ticker shape (1-5 caps) and get misrouted to yfinance equities.
const KNOWN_CRYPTO_BASES = new Set<string>([
  "PEPE", "SHIB", "BONK", "WIF", "FLOKI", "TRUMP", "TURBO",
  "INJ", "TIA", "TON", "JUP", "SEI", "STRK", "TAO", "RNDR",
  "FET", "AGIX", "OCEAN", "GRT", "FIL", "ICP", "APT", "LDO",
  "MKR", "COMP", "SNX", "CRV", "BAL", "1INCH", "GMX", "DYDX",
  "RUNE", "OSMO", "JTO", "PYTH", "MEME", "ORDI", "SATS",
])

// Permissive shape check. A "ticker-ish" string is 1-5 chars of uppercase
// letters, optionally with a single hyphen-separated suffix (BRK-B, BF-B,
// RDS-A class shares).
function looksLikeStockTicker(s: string): boolean {
  return /^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(s)
}

// Crypto bases tend to be 2-6 uppercase chars (BTC, ETH, DOGE, MATIC, USDT).
function looksLikeCryptoBase(s: string): boolean {
  return /^[A-Z0-9]{2,6}$/.test(s)
}

/**
 * Resolve any user-supplied symbol shape into a {@link SupportedSymbol}.
 *
 * 1. Curated registry hit → return rich metadata.
 * 2. Pair form (BTC/USD, BTC-USD, BTCUSDT, BTCUSDC, BTCUSD) → coerce base
 *    to the BASE/USD canonical shape and yfinance BASE-USD.
 * 3. Bare ticker (1-5 caps, optionally one class-share suffix) → assume
 *    stock/ETF, return as-is for both yfinance and canonical.
 * 4. Anything else → null.
 *
 * Steps 2 and 3 mark the result as {@link SupportedSymbol.unknown} so the
 * data layer knows to be defensive about empty results.
 */
export function resolveSymbol(input: string): SupportedSymbol | null {
  const raw = (input ?? "").trim()
  if (!raw) return null
  const upper = raw.toUpperCase().replace(/\s+/g, "")

  // (1) curated registry lookup — accepts name/yfinance/canonical forms
  // plus a few normalized pair shapes.
  const candidates = [upper]
  const stripPair = upper.replace(new RegExp(`[-/]?(${QUOTE_CURRENCIES.join("|")})$`), "")
  if (stripPair !== upper) candidates.push(stripPair)
  for (const c of candidates) {
    const hit = SUPPORTED_SYMBOLS.find((s) => s.name === c || s.yfinance === c || s.canonical === c)
    if (hit) return hit
  }

  // (2) crypto pair form: BASE/USD, BASE-USD, BASEUSD, BASEUSDT, BASEUSDC, BASEBUSD
  const sep = upper.match(new RegExp(`^([A-Z0-9]{2,6})[-/](${QUOTE_CURRENCIES.join("|")})$`))
  if (sep) return { name: sep[1], kind: "crypto", yfinance: `${sep[1]}-USD`, canonical: `${sep[1]}/USD`, unknown: true }
  const glued = upper.match(new RegExp(`^([A-Z0-9]{2,6})(${QUOTE_CURRENCIES.join("|")})$`))
  if (glued) return { name: glued[1], kind: "crypto", yfinance: `${glued[1]}-USD`, canonical: `${glued[1]}/USD`, unknown: true }

  // (3) Known crypto base (PEPE, SHIB, etc.) — checked BEFORE the stock
  // ticker fallback because the regexes overlap (4-letter caps match both).
  // Without this, "PEPE" would route to yfinance equities and fail.
  if (KNOWN_CRYPTO_BASES.has(upper)) {
    return { name: upper, kind: "crypto", yfinance: `${upper}-USD`, canonical: `${upper}/USD`, unknown: true }
  }

  // (4) Bare stock/ETF ticker — assume yfinance has it.
  if (looksLikeStockTicker(upper)) {
    return { name: upper, kind: "stock", yfinance: upper, canonical: upper, unknown: true }
  }

  // (5) Bare crypto base (no quote, not in known set). Last resort for
  // longer/numeric bases that aren't curated and don't look like stocks.
  if (looksLikeCryptoBase(upper)) {
    return { name: upper, kind: "crypto", yfinance: `${upper}-USD`, canonical: `${upper}/USD`, unknown: true }
  }

  return null
}

/**
 * Render the markets block used to fill the `<supported_markets/>` placeholder
 * in agent prompts. Compact, grep-stable, and explicitly says "and many more"
 * so the model knows it isn't restricted to this list.
 */
export function renderSupportedMarkets(): string {
  const crypto = listByKind("crypto").map((s) => s.name).join(", ")
  const stock = listByKind("stock").map((s) => s.name).join(", ")
  const etf = listByKind("etf").map((s) => s.name).join(", ")
  return [
    `- Crypto (24/7): ${crypto}`,
    `- Stocks (US market hours): ${stock}`,
    `- ETFs (US market hours): ${etf}`,
    `- And: any other yfinance-compatible ticker (most US-listed equities, ETFs, and major crypto pairs work). Try the symbol; the data layer will tell you if there's no data.`,
  ].join("\n")
}

const SUPPORTED_MARKETS_PLACEHOLDER = "<supported_markets/>"

/**
 * Replace every `<supported_markets/>` placeholder in a prompt template with
 * the rendered list. Agent.ts calls this at agent-table construction so prompts
 * and runtime tools share one symbol registry.
 */
export function renderPromptWithSymbols(prompt: string): string {
  return prompt.split(SUPPORTED_MARKETS_PLACEHOLDER).join(renderSupportedMarkets())
}
