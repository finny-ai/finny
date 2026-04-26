import crypto from "crypto"
import { Auth } from "@/auth"
import type { BrokerAccount, BrokerCredentials, BrokerSpec } from "./types"

export const ALPACA_PROVIDER_PREFIX = "alpaca-paper"
const DEFAULT_ENDPOINT = "https://paper-api.alpaca.markets"

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
  displayName: "Alpaca paper",
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
    { name: "endpoint", label: "Endpoint", default: DEFAULT_ENDPOINT },
  ],
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
    return {
      ALPACA_API_KEY_ID: creds.keyId,
      ALPACA_API_SECRET_KEY: creds.secret,
      ALPACA_ENDPOINT: creds.endpoint,
    }
  },
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
    accounts.push({
      providerID: key,
      brokerKind: "alpaca",
      label: meta.label ?? "Default",
      keyId: meta.keyId ?? "",
      endpoint: meta.endpoint ?? DEFAULT_ENDPOINT,
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
  return {
    keyId,
    secret: info.key,
    endpoint: meta.endpoint ?? DEFAULT_ENDPOINT,
  }
}
