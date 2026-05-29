import crypto from "crypto"
import { Auth } from "@/auth"
import type { BrokerAccount, BrokerCredentials, BrokerMode, BrokerSpec } from "./types"

export const ALPACA_PROVIDER_PREFIX = "alpaca-paper"
const PAPER_ENDPOINT = "https://paper-api.alpaca.markets"
const LIVE_ENDPOINT = "https://api.alpaca.markets"
const DEFAULT_ENDPOINT = PAPER_ENDPOINT
const DEFAULT_MODE: BrokerMode = "paper"

function isAlpacaMode(value: unknown): value is BrokerMode {
  return value === "paper" || value === "live"
}

function alpacaEndpointForMode(mode: BrokerMode): string {
  return mode === "live" ? LIVE_ENDPOINT : PAPER_ENDPOINT
}

const CRYPTO_BASES = new Set([
  "BTC", "ETH", "SOL", "DOGE", "AVAX", "MATIC", "LINK", "DOT", "ADA",
  "XRP", "LTC", "BCH", "UNI", "AAVE", "SUSHI", "SHIB",
])

// Alpaca crypto pairs are USD-quoted. Anything else gets remapped.
const ALPACA_PREFERRED_QUOTE = "USD"
const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "USD"]

function splitCanonical(canonical: string): { base: string; quote: string | null } | null {
  const u = canonical.toUpperCase().replace("-", "/")
  if (u.includes("/")) {
    const [base, quote] = u.split("/")
    if (!base) return null
    // Strict validation: a slash-separated string only counts as a crypto
    // pair if the quote is a currency we recognize OR the base is a known
    // crypto. Without this guard, IBKR option/future syntax (e.g.
    // "SPY/20260619/500C", "ES/CONT") leaks into Alpaca's "I support this"
    // signal and breaks cross-broker routing in compareForSymbol.
    if (quote && !KNOWN_QUOTES.includes(quote) && !CRYPTO_BASES.has(base)) {
      return null
    }
    return { base, quote: quote || null }
  }
  for (const q of KNOWN_QUOTES) {
    if (u.endsWith(q) && u.length > q.length) {
      return { base: u.slice(0, u.length - q.length), quote: q }
    }
  }
  if (CRYPTO_BASES.has(u)) return { base: u, quote: null }
  return null
}

export const alpacaSpec: BrokerSpec = {
  kind: "alpaca",
  displayName: "Alpaca",
  mode: "paper",
  providerPrefix: ALPACA_PROVIDER_PREFIX,
  pythonClass: "AlpacaBroker",
  pythonDeps: [
    { spec: "alpaca-py>=0.30", importCheck: "alpaca.trading.client" },
    { spec: "", importCheck: "alpaca.data.historical" },
  ],
  assetClasses: ["equity", "crypto"],
  staticTakerFee: 0.0025,
  defaultEndpoint: DEFAULT_ENDPOINT,
  docsUrl: "https://app.alpaca.markets/paper/dashboard/overview",
  credentialFields: [
    { name: "label", label: "Label" },
    { name: "keyId", label: "Key ID" },
    { name: "secret", label: "Secret", secret: true },
    { name: "mode", label: "Mode", default: DEFAULT_MODE, choices: ["paper", "live"] },
    { name: "endpoint", label: "Endpoint", default: DEFAULT_ENDPOINT },
  ],
  promptFragment: [
    "## Active brokerage: Alpaca",
    "",
    "The user's algorithm will run against an `AlpacaBroker` runtime (paper or live, picked at account-add time). The strategy itself stays broker-agnostic — use `self.broker.buy/sell/position/equity/cash/price` as usual; do NOT import `alpaca-py` or read `ALPACA_*` env vars from strategy code.",
    "",
    "**Asset classes (refuse mismatches):**",
    "- US equities and ETFs — `AAPL`, `SPY`, `TSLA`, `QQQ`, etc.",
    "- Crypto — USD-quoted only.",
    "- Futures (ES, NQ, CL, GC, etc.): Alpaca cannot execute futures live, but you CAN still build and backtest the strategy. Save with `asset_class: \"future\"` and pass `targetBrokerage: \"ibkr\"` to `finny_algorithm_save`. Tell the user: \"Strategy saved and backtested. To deploy live, connect an IBKR account via Settings → Brokerages.\" Do NOT fall back to ETF proxies (SPY for ES, QQQ for NQ) — that defeats futures mechanics (multiplier, margin, contract sizing).",
    "- Refuse: options, FX, non-US equities. If the user asks, say Alpaca can't trade these and there's no supported path yet.",
    "",
    "**`config.symbol` format:**",
    "- Equity: bare ticker — `\"AAPL\"`, `\"SPY\"`.",
    "- Crypto: slashed USD — `\"BTC/USD\"`, `\"ETH/USD\"`. Alpaca does NOT list USDT/USDC pairs; if the user says `\"BTC/USDT\"` either normalize to `\"BTC/USD\"` or refuse and explain.",
    "",
    "**Required first line of the saved `code`:**",
    "```python",
    "# Target broker: Alpaca",
    "```",
    "Without this comment the saved strategy is anonymous in code review. Always include it.",
  ].join("\n"),
  normalizeSymbol(canonical) {
    // Alpaca's modern API uses slashed form for crypto ("BTC/USD") and bare
    // tickers for equities ("AAPL"). resolvePair already handles both.
    return alpacaSpec.resolvePair(canonical)
  },
  resolvePair(canonical) {
    const u = canonical.toUpperCase()
    const split = splitCanonical(canonical)
    if (split) {
      // Crypto: always remap to USD (Alpaca's only crypto quote in v1).
      return `${split.base}/${ALPACA_PREFERRED_QUOTE}`
    }
    // Equity ticker pass-through (AAPL, TSLA, etc.).
    if (/^[A-Z]{1,5}$/.test(u)) return u
    return u
  },
  detectAssetClass(canonical) {
    const u = canonical.toUpperCase()
    if (splitCanonical(canonical)) return "crypto"
    if (/^[A-Z]{1,5}$/.test(u)) return "equity"
    return null
  },
  envVars(creds) {
    const mode = isAlpacaMode(creds.mode) ? creds.mode : DEFAULT_MODE
    // If the persisted endpoint matches the OTHER mode's default (i.e. the
    // user toggled mode after originally saving), fall back to the canonical
    // endpoint for the active mode so the Python runtime always points at
    // the right host.
    const expected = alpacaEndpointForMode(mode)
    const endpoint =
      creds.endpoint && creds.endpoint !== alpacaEndpointForMode(mode === "live" ? "paper" : "live")
        ? creds.endpoint
        : expected
    return {
      ALPACA_API_KEY_ID: creds.keyId,
      ALPACA_API_SECRET_KEY: creds.secret,
      ALPACA_ENDPOINT: endpoint,
      ALPACA_MODE: mode,
    }
  },
  endpointForMode: alpacaEndpointForMode,
}

function isAlpacaKey(key: string): boolean {
  return key === ALPACA_PROVIDER_PREFIX || key.startsWith(`${ALPACA_PROVIDER_PREFIX}-`)
}

export function generateAlpacaProviderID(): string {
  return `${ALPACA_PROVIDER_PREFIX}-${crypto.randomUUID()}`
}

export async function listAlpacaAccounts(): Promise<BrokerAccount[]> {
  const all = await Auth.all()
  const accounts: BrokerAccount[] = []
  for (const [key, info] of Object.entries(all)) {
    if (!isAlpacaKey(key)) continue
    if (info.type !== "api") continue
    const meta = (info as any).metadata ?? {}
    const mode = isAlpacaMode(meta.mode) ? meta.mode : DEFAULT_MODE
    accounts.push({
      providerID: key,
      brokerKind: "alpaca",
      label: meta.label ?? "Default",
      keyId: meta.keyId ?? "",
      endpoint: meta.endpoint ?? alpacaEndpointForMode(mode),
      mode,
    })
  }
  return accounts
}

export async function readAlpacaCredentials(providerID: string): Promise<BrokerCredentials | null> {
  const info = await Auth.get(providerID)
  if (!info || info.type !== "api") return null
  const meta = (info as any).metadata ?? {}
  const keyId = meta.keyId
  if (!keyId || !info.key) return null
  const mode = isAlpacaMode(meta.mode) ? meta.mode : DEFAULT_MODE
  return {
    keyId,
    secret: info.key,
    endpoint: meta.endpoint ?? alpacaEndpointForMode(mode),
    mode,
  }
}
