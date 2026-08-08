import { normalizeInterval } from "@/agent/request-identity"
import { regionalMarketForTicker } from "./regional-markets"

export type DataProviderFailureLayer = "provider" | "coverage" | "schema" | "retrieval"

export type DataProviderOutcome =
  | { status: "success"; provider: DataProviderID }
  | { status: "failure"; provider?: DataProviderID; layer: DataProviderFailureLayer; reason: string }

export type DataProviderID = "alpaca" | "polygon" | "yfinance" | "binance" | "zerodha" | "saxo" | "questrade" | "futu"

export interface DataProviderCapability {
  id: DataProviderID
  skillID: string
  assetClasses: readonly ("equity" | "crypto")[]
  intervals: readonly string[]
  credentialEnv: readonly string[]
  pagination: string
  availability: "available"
  evidenceContract: "DatasetEvidenceV2"
  calendarPolicy: "XNYS" | "24/7" | "REGIONAL_PROVIDER_OBSERVED"
  requiredMarketSemantics: readonly string[]
}

interface ProviderDefinition extends Omit<DataProviderCapability, "availability"> {
  supportsWindow?: (request: DataProviderRequest) => boolean
  supportsSymbol?: (request: DataProviderRequest) => boolean
}

export interface DataProviderRequest {
  assetClass?: string
  interval?: string
  start?: string
  end?: string
  symbol?: string
}

export interface DiscoverDataProviderCapabilitiesInput {
  request: DataProviderRequest
  availableSkillIDs: ReadonlySet<string>
  credentialEnv?: NodeJS.ProcessEnv
}

const EQUITY_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "1d"] as const
const BINANCE_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"] as const

const DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: "zerodha",
    skillID: "finny-provider-zerodha",
    assetClasses: ["equity"],
    intervals: ["1m", "5m", "15m", "30m", "1h", "1d"],
    credentialEnv: ["KITE_API_KEY", "KITE_ACCESS_TOKEN"],
    pagination: "resolve exact instrument token; split historical requests into bounded windows until covered",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "REGIONAL_PROVIDER_OBSERVED",
    requiredMarketSemantics: ["exact_listing", "venue", "currency", "provider_observed_calendar"],
    supportsSymbol: (request) => regionalMarketForTicker(request.symbol ?? "")?.brokerKind === "zerodha",
  },
  {
    id: "saxo",
    skillID: "finny-provider-saxo",
    assetClasses: ["equity"],
    intervals: EQUITY_INTERVALS,
    credentialEnv: ["SAXO_ACCESS_TOKEN"],
    pagination: "resolve exact Stock UIC and request chart samples until the immutable window is covered",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "REGIONAL_PROVIDER_OBSERVED",
    requiredMarketSemantics: ["exact_listing", "exchange", "currency", "data_version"],
    supportsSymbol: (request) => regionalMarketForTicker(request.symbol ?? "")?.brokerKind === "saxo",
  },
  {
    id: "questrade",
    skillID: "finny-provider-questrade",
    assetClasses: ["equity"],
    intervals: EQUITY_INTERVALS,
    credentialEnv: ["QUESTRADE_ACCESS_TOKEN", "QUESTRADE_API_SERVER"],
    pagination: "resolve exact symbol id; split requests below the 2000-candle response cap",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "REGIONAL_PROVIDER_OBSERVED",
    requiredMarketSemantics: ["exact_listing", "exchange", "currency", "access_token_only"],
    supportsSymbol: (request) => regionalMarketForTicker(request.symbol ?? "")?.brokerKind === "questrade",
  },
  {
    id: "futu",
    skillID: "finny-provider-futu",
    assetClasses: ["equity"],
    intervals: EQUITY_INTERVALS,
    credentialEnv: ["FUTU_HOST", "FUTU_PORT"],
    pagination: "follow page_req_key from OpenD until exhausted or the requested end is covered",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "REGIONAL_PROVIDER_OBSERVED",
    requiredMarketSemantics: ["exact_listing", "venue", "beijing_time", "historical_quota"],
    supportsSymbol: (request) => regionalMarketForTicker(request.symbol ?? "")?.brokerKind === "futu",
  },
  {
    id: "alpaca",
    skillID: "finny-provider-alpaca",
    assetClasses: ["equity"],
    intervals: EQUITY_INTERVALS,
    credentialEnv: ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"],
    pagination: "follow next_page_token until the inclusive request window is exhausted",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "XNYS",
    requiredMarketSemantics: ["feed", "venue", "adjustment=all", "corporate_actions"],
    supportsSymbol: (request) => !regionalMarketForTicker(request.symbol ?? ""),
  },
  {
    id: "polygon",
    skillID: "finny-provider-polygon",
    assetClasses: ["equity"],
    intervals: EQUITY_INTERVALS,
    credentialEnv: ["POLYGON_API_KEY"],
    pagination: "follow next_url until exhausted",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "XNYS",
    requiredMarketSemantics: ["feed", "venue", "adjustment", "corporate_actions"],
    supportsSymbol: (request) => !regionalMarketForTicker(request.symbol ?? ""),
  },
  {
    id: "yfinance",
    skillID: "finny-provider-yfinance",
    assetClasses: ["equity"],
    intervals: EQUITY_INTERVALS,
    credentialEnv: [],
    pagination: "single bounded window; do not retry a known public lookback limit",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "XNYS",
    requiredMarketSemantics: ["feed", "venue", "auto_adjust", "splits", "dividends"],
    supportsWindow: (request) => !isPublicYfinanceIntradayLimit(request),
  },
  {
    id: "binance",
    skillID: "finny-provider-binance",
    assetClasses: ["crypto"],
    intervals: BINANCE_INTERVALS,
    credentialEnv: [],
    pagination: "limit=1000; advance startTime from the last open time",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "24/7",
    requiredMarketSemantics: ["host", "venue", "raw_price_basis", "final_candle"],
  },
]

function utcDay(value?: string): number | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) ? parsed / 86_400_000 : undefined
}

function isPublicYfinanceIntradayLimit(request: DataProviderRequest) {
  if (normalizeInterval(request.interval) !== "5m") return false
  const start = utcDay(request.start)
  const end = utcDay(request.end)
  return start !== undefined && end !== undefined && end - start > 60
}

/**
 * Documented provider lookback limits, in days back from the current UTC day.
 * A request that starts before this floor cannot be served by that provider no
 * matter how the fetch is retried, so the floor is a mechanical fact rather
 * than a judgement call — `finny_workspace_edit` may clamp to it without
 * asking the user, while any other window change still needs approval.
 * Providers absent from this table have no fixed public floor.
 */
const PROVIDER_LOOKBACK_DAYS: Partial<Record<DataProviderID, Readonly<Record<string, number>>>> = {
  yfinance: { "1m": 30, "5m": 60, "15m": 60, "30m": 60, "1h": 730 },
}

/** Earliest `YYYY-MM-DD` a provider can serve for an interval, or undefined when unbounded. */
export function providerLookbackFloor(input: {
  provider: DataProviderID
  interval?: string
  now?: Date
}): string | undefined {
  const interval = normalizeInterval(input.interval)
  if (!interval) return undefined
  const days = PROVIDER_LOOKBACK_DAYS[input.provider]?.[interval]
  if (days === undefined) return undefined
  const now = input.now ?? new Date()
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))
  return floor.toISOString().slice(0, 10)
}

function normalizedAssetClass(value?: string): "equity" | "crypto" | undefined {
  const normalized = value?.trim().toLowerCase()
  if (["equity", "equities", "stock", "stocks", "etf"].includes(normalized ?? "")) return "equity"
  if (["crypto", "cryptocurrency"].includes(normalized ?? "")) return "crypto"
  return undefined
}

function hasCredentials(definition: ProviderDefinition, env: NodeJS.ProcessEnv) {
  return definition.credentialEnv.every((name) => Boolean(env[name]))
}

/** Return only capabilities that the worker can resolve and use for this request. */
export function discoverDataProviderCapabilities(
  input: DiscoverDataProviderCapabilitiesInput,
): DataProviderCapability[] {
  const assetClass = normalizedAssetClass(input.request.assetClass)
  const interval = normalizeInterval(input.request.interval)
  const env = input.credentialEnv ?? process.env
  return DEFINITIONS.filter((definition) => input.availableSkillIDs.has(definition.skillID))
    .filter((definition) => !assetClass || definition.assetClasses.includes(assetClass))
    .filter((definition) => !interval || definition.intervals.includes(interval))
    .filter((definition) => hasCredentials(definition, env))
    .filter((definition) => definition.supportsWindow?.(input.request) ?? true)
    .filter((definition) => definition.supportsSymbol?.(input.request) ?? true)
    .map(({ supportsWindow: _, supportsSymbol: __, ...definition }) => {
      const regionalFallback = definition.id === "yfinance" && regionalMarketForTicker(input.request.symbol ?? "")
      return {
        ...definition,
        ...(regionalFallback
          ? {
              calendarPolicy: "REGIONAL_PROVIDER_OBSERVED" as const,
              requiredMarketSemantics: [
                "exact_listing",
                "venue",
                "currency",
                "auto_adjust",
                "provider_observed_calendar",
              ],
            }
          : {}),
        availability: "available" as const,
      }
    })
}

/** Stable, compact context consumed by the Data Agent without filesystem probing. */
export function renderDataProviderCapabilities(capabilities: readonly DataProviderCapability[]): string[] {
  if (capabilities.length === 0) return ["- provider_capabilities: NONE (return a typed provider blocker)"]
  return [
    "Provider capabilities (runtime-resolved; do not probe for other provider skills or paths):",
    ...capabilities.map(
      (capability) =>
        `- provider=${capability.id}; skill_id=${capability.skillID}; asset_classes=${capability.assetClasses.join(",")}; intervals=${capability.intervals.join(",")}; pagination=${capability.pagination}; evidence_contract=${capability.evidenceContract}; calendar=${capability.calendarPolicy}; required_semantics=${capability.requiredMarketSemantics.join(",")}`,
    ),
  ]
}
