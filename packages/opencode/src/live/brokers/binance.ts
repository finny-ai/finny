import crypto from "crypto"
import { Auth } from "@/auth"
import type { BrokerAccount, BrokerCredentials, BrokerSpec } from "./types"

export const BINANCE_PROVIDER_PREFIX = "binance-testnet"
const TESTNET_REST = "https://testnet.binance.vision"

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
  displayName: "Binance testnet",
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
  ],
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
    return {
      BINANCE_API_KEY: creds.keyId,
      BINANCE_API_SECRET: creds.secret,
      BINANCE_TESTNET: "1",
    }
  },
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
    accounts.push({
      providerID: key,
      brokerKind: "binance",
      label: meta.label ?? "Default",
      keyId: meta.keyId ?? "",
      endpoint: TESTNET_REST,
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
  return { keyId, secret: info.key, endpoint: TESTNET_REST }
}
