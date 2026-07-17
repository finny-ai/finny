import crypto from "crypto"
import { Auth } from "@/auth"
import type { BrokerAccount, BrokerCredentials, BrokerMode, BrokerSpec } from "./types"
import { brokerModeChoices } from "./live-trading"

export const BINANCE_PROVIDER_PREFIX = "binance-testnet"
const TESTNET_REST = "https://testnet.binance.vision"
const LIVE_REST = "https://api.binance.com"
const DEFAULT_MODE: BrokerMode = "testnet"

function isBinanceMode(value: unknown): value is BrokerMode {
  return value === "testnet" || value === "live"
}

function binanceEndpointForMode(mode: BrokerMode): string {
  return mode === "live" ? LIVE_REST : TESTNET_REST
}

const CRYPTO_BASES = new Set([
  "BTC", "ETH", "SOL", "DOGE", "AVAX", "MATIC", "LINK", "DOT", "ADA",
  "XRP", "LTC", "BCH", "UNI", "AAVE", "SUSHI", "SHIB", "BNB", "TRX",
])

// Binance trades these quote currencies. Anything else (USD, EUR, …) gets
// remapped to USDT.
const BINANCE_QUOTES = ["USDT", "USDC", "BUSD", "BTC", "ETH"]
const BINANCE_PREFERRED_QUOTE = "USDT"
const RECOGNIZED_QUOTES = [...BINANCE_QUOTES, "USD"]

function splitPair(canonical: string): { base: string; quote: string | null } | null {
  const u = canonical.toUpperCase().replace("-", "/")
  if (u.includes("/")) {
    const [base, quote] = u.split("/")
    if (!base) return null
    // Strict validation: only treat slash-pairs as crypto if the quote is one
    // we trade or the base is a known crypto. Stops IBKR-style option/future
    // strings ("SPY/20260619/500C", "ES/CONT") from being claimed by Binance.
    if (quote && !RECOGNIZED_QUOTES.includes(quote) && !CRYPTO_BASES.has(base)) {
      return null
    }
    return { base, quote: quote || null }
  }
  for (const q of RECOGNIZED_QUOTES) {
    if (u.endsWith(q) && u.length > q.length) {
      return { base: u.slice(0, u.length - q.length), quote: q }
    }
  }
  if (CRYPTO_BASES.has(u)) return { base: u, quote: null }
  return null
}

export const binanceSpec: BrokerSpec = {
  kind: "binance",
  displayName: "Binance",
  mode: "testnet",
  providerPrefix: BINANCE_PROVIDER_PREFIX,
  pythonClass: "BinanceBroker",
  pythonDeps: [{ spec: "ccxt>=4", importCheck: "ccxt" }],
  assetClasses: ["crypto"],
  staticTakerFee: 0.001,
  defaultEndpoint: TESTNET_REST,
  docsUrl: "https://testnet.binance.vision/",
  credentialFields: [
    { name: "label", label: "Label" },
    { name: "keyId", label: "API key" },
    { name: "secret", label: "API secret", secret: true },
    { name: "mode", label: "Mode", default: DEFAULT_MODE, choices: brokerModeChoices(["testnet", "live"]) },
    { name: "endpoint", label: "Endpoint", default: TESTNET_REST },
  ],
  promptFragment: [
    "## Active brokerage: Binance",
    "",
    "The user's algorithm will run against a `BinanceBroker` runtime (testnet or live, picked at account-add time). The strategy stays broker-agnostic — use `self.broker.buy/sell/position/equity/cash/price`; do NOT import `ccxt` or read `BINANCE_*` env vars from strategy code.",
    "",
    "**Asset class (refuse mismatches):**",
    "- Crypto only.",
    "- Refuse: equities (AAPL, SPY), ETFs, futures, options, FX. If the user asks for stocks, tell them to switch to Alpaca via the Brokerage capsule.",
    "",
    "**`config.symbol` format:** ccxt unified — `\"BASE/QUOTE\"`.",
    "- Quote MUST be one of `USDT`, `USDC`, `BUSD`, `BTC`, `ETH`. Prefer `USDT`.",
    "- Examples: `\"BTC/USDT\"`, `\"ETH/USDT\"`, `\"SOL/USDC\"`.",
    "- If the user writes `\"BTC-USD\"`, `\"BTCUSD\"`, or `\"BTC/USD\"`, normalize to `\"BTC/USDT\"` and call out the substitution. Binance does not list USD-quoted pairs.",
    "",
    "**Required first line of the saved `code`:**",
    "```python",
    "# Target broker: Binance",
    "```",
    "Without this comment the saved strategy is anonymous in code review. Always include it.",
  ].join("\n"),
  normalizeSymbol(canonical) {
    return binanceSpec.resolvePair(canonical)
  },
  resolvePair(canonical) {
    const split = splitPair(canonical)
    if (!split) return canonical.toUpperCase().replace("-", "/")
    const quote =
      split.quote && BINANCE_QUOTES.includes(split.quote) ? split.quote : BINANCE_PREFERRED_QUOTE
    return `${split.base}/${quote}`
  },
  detectAssetClass(canonical) {
    return splitPair(canonical) ? "crypto" : null
  },
  envVars(creds) {
    const mode = isBinanceMode(creds.mode) ? creds.mode : DEFAULT_MODE
    const expected = binanceEndpointForMode(mode)
    const opposite = binanceEndpointForMode(mode === "live" ? "testnet" : "live")
    const endpoint = creds.endpoint && creds.endpoint !== opposite ? creds.endpoint : expected
    return {
      BINANCE_API_KEY: creds.keyId,
      BINANCE_API_SECRET: creds.secret,
      BINANCE_ENDPOINT: endpoint,
      BINANCE_MODE: mode,
      // Kept for backwards compatibility with any existing python that
      // checks the testnet flag directly. New code should prefer BINANCE_MODE.
      BINANCE_TESTNET: mode === "testnet" ? "1" : "0",
    }
  },
  endpointForMode: binanceEndpointForMode,
}

function isBinanceKey(key: string): boolean {
  return key === BINANCE_PROVIDER_PREFIX || key.startsWith(`${BINANCE_PROVIDER_PREFIX}-`)
}

export function generateBinanceProviderID(): string {
  return `${BINANCE_PROVIDER_PREFIX}-${crypto.randomUUID()}`
}

export async function listBinanceAccounts(): Promise<BrokerAccount[]> {
  const all = await Auth.all()
  const accounts: BrokerAccount[] = []
  for (const [key, info] of Object.entries(all)) {
    if (!isBinanceKey(key)) continue
    if (info.type !== "api") continue
    const meta = (info as any).metadata ?? {}
    const mode = isBinanceMode(meta.mode) ? meta.mode : DEFAULT_MODE
    accounts.push({
      providerID: key,
      brokerKind: "binance",
      label: meta.label ?? "Default",
      keyId: meta.keyId ?? "",
      endpoint: meta.endpoint ?? binanceEndpointForMode(mode),
      mode,
    })
  }
  return accounts
}

export async function readBinanceCredentials(providerID: string): Promise<BrokerCredentials | null> {
  const info = await Auth.get(providerID)
  if (!info || info.type !== "api") return null
  const meta = (info as any).metadata ?? {}
  const keyId = meta.keyId
  if (!keyId || !info.key) return null
  const mode = isBinanceMode(meta.mode) ? meta.mode : DEFAULT_MODE
  return {
    keyId,
    secret: info.key,
    endpoint: meta.endpoint ?? binanceEndpointForMode(mode),
    mode,
  }
}
