import { normalizeInterval } from "@/agent/request-identity"

export type DataProviderFailureLayer = "provider" | "coverage" | "schema" | "retrieval"

export type DataProviderOutcome =
  | { status: "success"; provider: DataProviderID }
  | { status: "failure"; provider?: DataProviderID; layer: DataProviderFailureLayer; reason: string }

export type DataProviderID = "alpaca" | "polygon" | "yfinance" | "binance"

export interface DataProviderCapability {
  id: DataProviderID
  skillID: string
  assetClasses: readonly ("equity" | "crypto")[]
  intervals: readonly string[]
  credentialEnv: readonly string[]
  pagination: string
  availability: "available"
  evidenceContract: "DatasetEvidenceV2"
  calendarPolicy: "XNYS" | "24/7"
  requiredMarketSemantics: readonly string[]
}

interface ProviderDefinition extends Omit<DataProviderCapability, "availability"> {
  supportsWindow?: (request: DataProviderRequest) => boolean
}

export interface DataProviderRequest {
  assetClass?: string
  interval?: string
  start?: string
  end?: string
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
    id: "alpaca",
    skillID: "finny-provider-alpaca",
    assetClasses: ["equity"],
    intervals: EQUITY_INTERVALS,
    credentialEnv: ["ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY"],
    pagination: "follow next_page_token until the inclusive request window is exhausted",
    evidenceContract: "DatasetEvidenceV2",
    calendarPolicy: "XNYS",
    requiredMarketSemantics: ["feed", "venue", "adjustment=all", "corporate_actions"],
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
    .map(({ supportsWindow: _, ...definition }) => ({ ...definition, availability: "available" as const }))
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
