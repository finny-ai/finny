import crypto from "crypto"
import { Auth } from "@/auth"
import {
  isRegionalEquityTicker,
  normalizeRegionalTicker,
  regionalMarketForTicker,
  regionalNativeSymbol,
  type RegionalBrokerKind,
} from "@/data/regional-markets"
import type { BrokerAccount, BrokerCredentials, BrokerMode, BrokerSpec, CredentialField } from "./types"
import { brokerModeChoices } from "./live-trading"

type RegionalDefinition = {
  kind: RegionalBrokerKind
  displayName: string
  prefix: string
  defaultEndpoint: string
  docsUrl: string
  regions: string[]
  suffixes: string[]
  credentialFields: CredentialField[]
  env: (credentials: BrokerCredentials) => Record<string, string>
}

const APPROVED_REGIONAL_PROMPT = [
  "## Regional equity markets",
  "",
  "Preserve the exact listed-market ticker throughout strategy generation, data extraction, backtesting, and brokerage routing. Never replace a regional listing with a US ticker, ADR, ETF, or other proxy unless the user explicitly requests one.",
  "",
  "Supported brokerage routes:",
  "- India: Zerodha — `.NS` for NSE and `.BO` for BSE, for example `RELIANCE.NS`.",
  "- Europe: Saxo — exchange-qualified Yahoo tickers such as `ASML.AS`, `SAP.DE`, and `AIR.PA`.",
  "- Canada: Questrade — `.TO` for TSX and `.V` for TSX Venture, for example `SHOP.TO`.",
  "- China/Hong Kong: Futu — `.SS`, `.SZ`, and `.HK`, for example `600519.SS` and `0700.HK`.",
  "",
  "Strategies remain broker-agnostic and use `self.broker.buy`, `sell`, `position`, `cash`, `equity`, and `price`. Regional order submission remains disabled unless the runtime has an audited execution adapter and explicit paper/live approval. Data extraction and backtesting do not authorize trading.",
].join("\n")

const DEFINITIONS: Record<RegionalBrokerKind, RegionalDefinition> = {
  zerodha: {
    kind: "zerodha",
    displayName: "Zerodha",
    prefix: "zerodha",
    defaultEndpoint: "https://api.kite.trade",
    docsUrl: "https://kite.trade/docs/connect/v3/",
    regions: ["india"],
    suffixes: [".NS", ".BO"],
    credentialFields: [
      { name: "label", label: "Label" },
      { name: "keyId", label: "Kite API key" },
      { name: "secret", label: "Kite access token", secret: true },
      { name: "endpoint", label: "API endpoint", default: "https://api.kite.trade" },
      { name: "mode", label: "Mode", default: "live", choices: brokerModeChoices(["live"]) },
    ],
    env: (creds) => ({ KITE_API_KEY: creds.keyId, KITE_ACCESS_TOKEN: creds.secret, KITE_ENDPOINT: creds.endpoint }),
  },
  saxo: {
    kind: "saxo",
    displayName: "Saxo",
    prefix: "saxo",
    defaultEndpoint: "https://gateway.saxobank.com/sim/openapi",
    docsUrl: "https://www.developer.saxo/openapi/learn/welcome",
    regions: ["europe"],
    suffixes: [".AS", ".BR", ".DE", ".L", ".MC", ".MI", ".PA", ".SW"],
    credentialFields: [
      { name: "label", label: "Label" },
      { name: "keyId", label: "Account key" },
      { name: "secret", label: "OAuth access token", secret: true },
      { name: "endpoint", label: "OpenAPI endpoint", default: "https://gateway.saxobank.com/sim/openapi" },
      { name: "mode", label: "Mode", default: "paper", choices: brokerModeChoices(["paper", "live"]) },
    ],
    env: (creds) => ({ SAXO_ACCOUNT_KEY: creds.keyId, SAXO_ACCESS_TOKEN: creds.secret, SAXO_ENDPOINT: creds.endpoint }),
  },
  questrade: {
    kind: "questrade",
    displayName: "Questrade",
    prefix: "questrade",
    defaultEndpoint: "https://api01.iq.questrade.com/",
    docsUrl: "https://www.questrade.com/api/documentation/getting-started",
    regions: ["canada"],
    suffixes: [".TO", ".V"],
    credentialFields: [
      { name: "label", label: "Label" },
      { name: "keyId", label: "Account ID" },
      { name: "secret", label: "Access token", secret: true },
      { name: "endpoint", label: "API server", default: "https://api01.iq.questrade.com/" },
      { name: "mode", label: "Mode", default: "live", choices: brokerModeChoices(["live"]) },
    ],
    env: (creds) => ({
      QUESTRADE_ACCOUNT_ID: creds.keyId,
      QUESTRADE_ACCESS_TOKEN: creds.secret,
      QUESTRADE_API_SERVER: creds.endpoint,
    }),
  },
  futu: {
    kind: "futu",
    displayName: "Futu OpenD",
    prefix: "futu",
    defaultEndpoint: "127.0.0.1:11111",
    docsUrl: "https://openapi.futunn.com/futu-api-doc/en/",
    regions: ["china"],
    suffixes: [".SS", ".SZ", ".HK"],
    credentialFields: [
      { name: "label", label: "Label" },
      { name: "keyId", label: "Trading account ID (optional for data)", required: false },
      { name: "secret", label: "Trading unlock password (optional for data)", secret: true, required: false },
      { name: "endpoint", label: "OpenD host:port", default: "127.0.0.1:11111" },
      { name: "mode", label: "Mode", default: "paper", choices: brokerModeChoices(["paper", "live"]) },
    ],
    env: (creds) => {
      const [host, port = "11111"] = creds.endpoint.replace(/^tcp:\/\//i, "").split(":")
      return {
        FUTU_ACCOUNT_ID: creds.keyId,
        FUTU_UNLOCK_PASSWORD: creds.secret,
        FUTU_HOST: host || "127.0.0.1",
        FUTU_PORT: port,
      }
    },
  },
}

function mode(value: unknown, fallback: BrokerMode): BrokerMode {
  return value === "paper" || value === "testnet" || value === "live" ? value : fallback
}

function makeSpec(definition: RegionalDefinition): BrokerSpec {
  const defaultMode: BrokerMode = definition.kind === "saxo" || definition.kind === "futu" ? "paper" : "live"
  const spec: BrokerSpec = {
    kind: definition.kind,
    displayName: definition.displayName,
    mode: defaultMode,
    providerPrefix: definition.prefix,
    pythonClass: "DataOnlyRegionalBroker",
    pythonDeps: [],
    assetClasses: ["equity"],
    staticTakerFee: 0,
    defaultEndpoint: definition.defaultEndpoint,
    docsUrl: definition.docsUrl,
    credentialFields: definition.credentialFields,
    promptFragment: APPROVED_REGIONAL_PROMPT,
    executionSupport: "data_only",
    normalizeSymbol: normalizeRegionalTicker,
    resolvePair(canonical) {
      return regionalNativeSymbol(canonical) ?? normalizeRegionalTicker(canonical)
    },
    detectAssetClass(canonical) {
      const market = regionalMarketForTicker(canonical)
      return market?.brokerKind === definition.kind && isRegionalEquityTicker(canonical) ? "equity" : null
    },
    envVars: definition.env,
  }
  return spec
}

export const zerodhaSpec = makeSpec(DEFINITIONS.zerodha)
export const saxoSpec = makeSpec(DEFINITIONS.saxo)
export const questradeSpec = makeSpec(DEFINITIONS.questrade)
export const futuSpec = makeSpec(DEFINITIONS.futu)

export const REGIONAL_BROKER_SPECS = {
  zerodha: zerodhaSpec,
  saxo: saxoSpec,
  questrade: questradeSpec,
  futu: futuSpec,
} as const

function accountKey(kind: RegionalBrokerKind, key: string): boolean {
  const prefix = DEFINITIONS[kind].prefix
  return key === prefix || key.startsWith(`${prefix}-`)
}

export function generateRegionalProviderID(kind: RegionalBrokerKind): string {
  return `${DEFINITIONS[kind].prefix}-${crypto.randomUUID()}`
}

export async function listRegionalAccounts(kind: RegionalBrokerKind): Promise<BrokerAccount[]> {
  const definition = DEFINITIONS[kind]
  const all = await Auth.all()
  const accounts: BrokerAccount[] = []
  for (const [providerID, info] of Object.entries(all)) {
    if (!accountKey(kind, providerID) || info.type !== "api") continue
    const metadata = (info as any).metadata ?? {}
    accounts.push({
      providerID,
      brokerKind: kind,
      label: metadata.label ?? "Default",
      keyId: metadata.keyId ?? "",
      endpoint: metadata.endpoint ?? definition.defaultEndpoint,
      mode: mode(metadata.mode, kind === "saxo" || kind === "futu" ? "paper" : "live"),
    })
  }
  return accounts
}

export async function readRegionalCredentials(
  kind: RegionalBrokerKind,
  providerID: string,
): Promise<BrokerCredentials | null> {
  const definition = DEFINITIONS[kind]
  if (!accountKey(kind, providerID)) return null
  const info = await Auth.get(providerID)
  if (!info || info.type !== "api") return null
  const metadata = (info as any).metadata ?? {}
  if (!metadata.keyId && kind !== "futu") return null
  return {
    keyId: metadata.keyId ?? "",
    secret: info.key ?? "",
    endpoint: metadata.endpoint ?? definition.defaultEndpoint,
    mode: mode(metadata.mode, kind === "saxo" || kind === "futu" ? "paper" : "live"),
  }
}
