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
  expiry?: string
  rollPolicy?: string
  quoteCurrency?: string
  baseCurrency?: string
  blockingReason?: string
}

export function normalizeAssetClass(value: unknown, symbol?: string): AssetClass {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (raw === "crypto") return "crypto_spot"
  if (raw === "equity" || raw === "crypto_spot" || raw === "crypto_perp" || raw === "future" || raw === "fx" || raw === "option") {
    return raw
  }
  const sym = String(symbol ?? "").toUpperCase()
  if (sym.includes("/") || sym.includes("-") || sym.endsWith("USDT") || sym.endsWith("USD")) return "crypto_spot"
  return "equity"
}

export function requiresExplicitAssetClass(assetClass: AssetClass): boolean {
  return assetClass === "crypto_perp" || assetClass === "future" || assetClass === "fx" || assetClass === "option"
}

export function resolveAssetSpec(config: any, symbolFallback: string): AssetSpec {
  const symbol = String(config?.symbol ?? symbolFallback).toUpperCase()
  const rawAssetClass = config?.asset_class ?? config?.assetClass
  const assetClass = normalizeAssetClass(rawAssetClass, symbol)
  if (requiresExplicitAssetClass(assetClass) && typeof rawAssetClass !== "string") {
    throw new Error(`asset_class must be explicit for ${assetClass} strategies.`)
  }

  const specOverrides = (config?.asset_spec ?? config?.assetSpec ?? {}) as Record<string, unknown>
  const execution = (config?.execution ?? {}) as Record<string, unknown>
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
    return {
      ...common,
      assetClass,
      venue: "CME",
      calendar: "US_FUTURES",
      tickSize: 0.25,
      lotSize: 1,
      multiplier: 50,
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
