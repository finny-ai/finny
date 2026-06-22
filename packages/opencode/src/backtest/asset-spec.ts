export type AssetClass = "crypto_spot" | "crypto_perp" | "equity" | "future" | "fx" | "option"
export type LegacyAssetClass = "crypto" | "equity"

export interface AssetSpec {
  assetClass: AssetClass
  symbol: string
  venue?: string
  currency: string
  calendar: string
  tickSize: number
  lotSize: number
  multiplier: number
  feeModel: string
  marginModel: string
  dataProvider: string
  productionEligible: boolean
  initialMarginPct?: number
  maintenanceMarginPct?: number
  commissionPerContract?: number
  expiry?: string
  rollPolicy?: string
  quoteCurrency?: string
  baseCurrency?: string
  blockingReason?: string
}

const CRYPTO_BASES = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK", "UNI"])
const OPTION_RE = /^(?:[A-Z]{1,6}\/\d{8}\/\d+(?:\.\d+)?[CP]|[A-Z]{1,6}\d{6}[CP]\d{8})$/i
const FUTURES_SPECS = {
  ES: { venue: "CME", tickSize: 0.25, multiplier: 50, currency: "USD", initialMarginPct: 0.05, maintenanceMarginPct: 0.04, commissionPerContract: 2.25 },
  NQ: { venue: "CME", tickSize: 0.25, multiplier: 20, currency: "USD", initialMarginPct: 0.06, maintenanceMarginPct: 0.05, commissionPerContract: 2.25 },
  RTY: { venue: "CME", tickSize: 0.1, multiplier: 50, currency: "USD", initialMarginPct: 0.07, maintenanceMarginPct: 0.06, commissionPerContract: 2.25 },
  YM: { venue: "CBOT", tickSize: 1, multiplier: 5, currency: "USD", initialMarginPct: 0.05, maintenanceMarginPct: 0.04, commissionPerContract: 2.25 },
  CL: { venue: "NYMEX", tickSize: 0.01, multiplier: 1000, currency: "USD", initialMarginPct: 0.1, maintenanceMarginPct: 0.08, commissionPerContract: 2.75 },
  GC: { venue: "COMEX", tickSize: 0.1, multiplier: 100, currency: "USD", initialMarginPct: 0.08, maintenanceMarginPct: 0.06, commissionPerContract: 2.6 },
  SI: { venue: "COMEX", tickSize: 0.005, multiplier: 5000, currency: "USD", initialMarginPct: 0.12, maintenanceMarginPct: 0.1, commissionPerContract: 2.9 },
  HG: { venue: "COMEX", tickSize: 0.0005, multiplier: 25000, currency: "USD", initialMarginPct: 0.09, maintenanceMarginPct: 0.07, commissionPerContract: 2.75 },
  ZN: { venue: "CBOT", tickSize: 0.015625, multiplier: 1000, currency: "USD", initialMarginPct: 0.03, maintenanceMarginPct: 0.025, commissionPerContract: 2.1 },
  ZB: { venue: "CBOT", tickSize: 0.03125, multiplier: 1000, currency: "USD", initialMarginPct: 0.04, maintenanceMarginPct: 0.03, commissionPerContract: 2.1 },
  "6E": { venue: "CME", tickSize: 0.00005, multiplier: 125000, currency: "USD", initialMarginPct: 0.04, maintenanceMarginPct: 0.03, commissionPerContract: 2.4 },
} as const

function futuresRoot(symbol: string): keyof typeof FUTURES_SPECS | undefined {
  const root = symbol.toUpperCase().replace(/=F$/, "").replace(/\/CONT$/, "")
  return root in FUTURES_SPECS ? root as keyof typeof FUTURES_SPECS : undefined
}

export function normalizeAssetClass(value: unknown, symbol?: string): AssetClass {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (raw === "crypto") return "crypto_spot"
  if (raw === "equity" || raw === "crypto_spot" || raw === "crypto_perp" || raw === "future" || raw === "fx" || raw === "option") {
    return raw
  }
  const sym = String(symbol ?? "").toUpperCase()
  if (OPTION_RE.test(sym)) return "option"
  if (futuresRoot(sym)) return "future"
  if (/^[A-Z]{6}$/.test(sym) && !CRYPTO_BASES.has(sym.slice(0, 3))) return "fx"
  if (/^[A-Z]{3}[/-][A-Z]{3}$/.test(sym) && !CRYPTO_BASES.has(sym.slice(0, 3))) return "fx"
  if (sym.includes("/") || sym.includes("-") || sym.endsWith("USDT") || sym.endsWith("USD")) return "crypto_spot"
  return "equity"
}

export function requiresExplicitAssetClass(assetClass: AssetClass): boolean {
  return assetClass === "crypto_perp" || assetClass === "fx" || assetClass === "option"
}

export function resolveAssetSpec(config: any, symbolFallback: string): AssetSpec {
  const symbol = String(config?.symbol ?? symbolFallback).toUpperCase()
  const rawAssetClass = config?.asset_class ?? config?.assetClass
  const assetClass = normalizeAssetClass(rawAssetClass, symbol)
  const inferredAssetClass = normalizeAssetClass(undefined, symbol)
  if (requiresExplicitAssetClass(assetClass) && typeof rawAssetClass !== "string") {
    throw new Error(`asset_class must be explicit for ${assetClass} strategies.`)
  }

  const specOverrides = (config?.asset_spec ?? config?.assetSpec ?? {}) as Record<string, unknown>
  const execution = (config?.execution ?? {}) as Record<string, unknown>
  const hasCompleteCustomSpec = [
    "tickSize",
    "lotSize",
    "multiplier",
    "calendar",
    "currency",
    "feeModel",
    "marginModel",
    "dataProvider",
  ].every((key) => specOverrides[key] != null)
  const compatibleOverride = new Set([assetClass, inferredAssetClass])
  const compatibleCryptoMode =
    compatibleOverride.size <= 2 && compatibleOverride.has("crypto_spot") && compatibleOverride.has("crypto_perp")
  if (typeof rawAssetClass === "string" && assetClass !== inferredAssetClass && !compatibleCryptoMode && !hasCompleteCustomSpec) {
    throw new Error(
      `asset_class ${assetClass} is inconsistent with symbol "${symbol}" ` +
        `(inferred ${inferredAssetClass}). Supply a complete custom asset_spec to override inference.`,
    )
  }

  // Guard unknown futures roots: silently simulating an unsupported/typo'd
  // contract with ES specs would produce wrong margin/tick/multiplier (and thus
  // wrong sizing, fees, and liquidation) with no warning. Require an explicit
  // asset_spec override (multiplier + tickSize at minimum) instead.
  if (assetClass === "future" && !futuresRoot(symbol)) {
    const hasOverride = specOverrides.multiplier != null && specOverrides.tickSize != null
    if (!hasOverride) {
      throw new Error(
        `Unsupported futures root for symbol "${symbol}". ` +
          `Supported roots: ${Object.keys(FUTURES_SPECS).join(", ")}. ` +
          `To backtest another contract, pass an explicit asset_spec with at least multiplier and tickSize.`,
      )
    }
  }

  const base = defaultsFor(assetClass, symbol, execution)
  const merged = { ...base, ...specOverrides, assetClass, symbol }
  validateAssetSpec(merged)
  return merged
}

function defaultsFor(assetClass: AssetClass, symbol: string, execution: Record<string, unknown>): AssetSpec {
  const common = {
    symbol,
    currency: "USD",
    feeModel: "engine_v2.execution.costs",
    marginModel: "engine_v2.portfolio.account",
    dataProvider: "yfinance",
  }
  if (assetClass === "crypto_spot") {
    return {
      ...common,
      assetClass,
      venue: "crypto",
      calendar: "24/7",
      tickSize: 0.01,
      lotSize: 0.00000001,
      multiplier: 1,
      productionEligible: true,
    }
  }
  if (assetClass === "crypto_perp") {
    return {
      ...common,
      assetClass,
      venue: "crypto_perp",
      calendar: "24/7",
      tickSize: 0.01,
      lotSize: 0.001,
      multiplier: 1,
      productionEligible: Number(execution.funding_rate_bps ?? 0) !== 0 && Number(execution.maintenance_margin_pct ?? 0) > 0,
      blockingReason: Number(execution.funding_rate_bps ?? 0) === 0 ? "Perp production eligibility requires funding enabled." : undefined,
    }
  }
  if (assetClass === "future") {
    const spec = FUTURES_SPECS[futuresRoot(symbol) ?? "ES"]
    return {
      ...common,
      ...spec,
      assetClass,
      calendar: "US_FUTURES",
      lotSize: 1,
      productionEligible: true,
      rollPolicy: "continuous_contract_assumed",
    }
  }
  if (assetClass === "fx") {
    const baseCurrency = symbol.slice(0, 3)
    const quoteCurrency = symbol.slice(3, 6) || "USD"
    return {
      ...common,
      assetClass,
      venue: "fx_spot",
      currency: quoteCurrency,
      calendar: "FX_24_5",
      tickSize: quoteCurrency === "JPY" ? 0.01 : 0.0001,
      lotSize: 1000,
      multiplier: 1,
      productionEligible: true,
      baseCurrency,
      quoteCurrency,
    }
  }
  if (assetClass === "option") {
    return {
      ...common,
      assetClass,
      venue: "OPRA",
      calendar: "US_OPTIONS",
      tickSize: 0.01,
      lotSize: 1,
      multiplier: 100,
      productionEligible: false,
      blockingReason: "Options require pricing, Greeks, exercise/assignment, IV surface, and liquidity models before production eligibility.",
    }
  }
  return {
    ...common,
    assetClass,
    venue: "equity",
    calendar: "US_EQUITIES",
    tickSize: 0.01,
    lotSize: 1,
    multiplier: 1,
    productionEligible: true,
  }
}

function validateAssetSpec(spec: AssetSpec): void {
  if (!Number.isFinite(spec.tickSize) || spec.tickSize <= 0) throw new Error("AssetSpec.tickSize must be positive.")
  if (!Number.isFinite(spec.lotSize) || spec.lotSize <= 0) throw new Error("AssetSpec.lotSize must be positive.")
  if (!Number.isFinite(spec.multiplier) || spec.multiplier <= 0) throw new Error("AssetSpec.multiplier must be positive.")
  if (!spec.currency || !spec.calendar || !spec.feeModel || !spec.marginModel || !spec.dataProvider) {
    throw new Error("AssetSpec is missing required metadata.")
  }
}
