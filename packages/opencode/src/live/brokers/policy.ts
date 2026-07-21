import { BrokerRegistry } from "./index"
import type { AssetClass, BrokerKind } from "./types"

const OPTION_RE = /^([A-Z]{1,6})\/(\d{8})\/(\d+(?:\.\d+)?)([CP])$/i
const FUTURE_RE = /^([A-Z0-9]{1,5})\/(\d{6}|CONT)$/i

const TARGET_BROKER_LABEL_TO_KIND: Record<string, BrokerKind> = {
  alpaca: "alpaca",
  binance: "binance",
  ibkr: "ibkr",
  zerodha: "zerodha",
  saxo: "saxo",
  questrade: "questrade",
  futu: "futu",
}

export type PolicyErrorCode =
  | "OPTIONS_REQUIRE_IBKR"
  | "BROKER_SYMBOL_MISMATCH"
  | "PROXY_BACKTEST_NOT_ALLOWED"
  | "OPTIONS_WITH_EQUITY_PROXY_SYMBOL"

export interface PolicyValidation {
  ok: boolean
  code?: PolicyErrorCode
  message?: string
  assetClass?: AssetClass | null
  normalizedSymbol?: string
}

export function isOptionSymbol(symbol: string): boolean {
  return OPTION_RE.test(String(symbol || "").trim())
}

export function optionUnderlying(symbol: string): string | null {
  const match = String(symbol || "")
    .trim()
    .toUpperCase()
    .match(OPTION_RE)
  return match ? match[1] : null
}

export function isFutureSymbol(symbol: string): boolean {
  return FUTURE_RE.test(String(symbol || "").trim())
}

export function parseTargetBrokerComment(code: string): BrokerKind | null {
  const firstNonEmpty = String(code || "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstNonEmpty) return null
  const match = firstNonEmpty.match(/^#\s*Target broker:\s*(.+)$/i)
  if (!match) return null
  const label = match[1].trim().toLowerCase()
  return TARGET_BROKER_LABEL_TO_KIND[label] ?? null
}

export function detectSymbolAssetClass(symbol: string): AssetClass | null {
  const seen = new Set<AssetClass>()
  for (const spec of BrokerRegistry.specs()) {
    const assetClass = spec.detectAssetClass(String(symbol || "").trim())
    if (assetClass) seen.add(assetClass)
  }
  if (seen.size !== 1) return seen.size === 0 ? null : null
  return Array.from(seen)[0]
}

export function normalizeSymbolForBroker(symbol: string, brokerKind: BrokerKind): string {
  const spec = BrokerRegistry.getSpec(brokerKind)
  return spec.normalizeSymbol(String(symbol || "").trim())
}

export function validateSymbolForBroker(symbol: string, brokerKind: BrokerKind): PolicyValidation {
  const spec = BrokerRegistry.getSpec(brokerKind)
  const assetClass = spec.detectAssetClass(String(symbol || "").trim())
  if (!assetClass || !spec.assetClasses.includes(assetClass)) {
    return {
      ok: false,
      code: isOptionSymbol(symbol) ? "OPTIONS_REQUIRE_IBKR" : "BROKER_SYMBOL_MISMATCH",
      message: isOptionSymbol(symbol)
        ? `Option symbol "${symbol}" requires IBKR. ${spec.displayName} does not support options.`
        : `Symbol "${symbol}" is not compatible with ${spec.displayName}.`,
      assetClass,
    }
  }
  return {
    ok: true,
    assetClass,
    normalizedSymbol: spec.normalizeSymbol(String(symbol || "").trim()),
  }
}

export function validateOptionProxyMutation(
  previousSymbol: string | undefined,
  nextSymbol: string | undefined,
): PolicyValidation {
  if (previousSymbol && isOptionSymbol(previousSymbol) && nextSymbol && !isOptionSymbol(nextSymbol)) {
    return {
      ok: false,
      code: "PROXY_BACKTEST_NOT_ALLOWED",
      message:
        `Refusing to replace option symbol "${previousSymbol}" with underlying/proxy symbol "${nextSymbol}". ` +
        `Keep the live symbol unchanged and use backtest.proxy_symbol for explicit proxy research.`,
      assetClass: "option",
    }
  }
  return { ok: true, assetClass: nextSymbol ? detectSymbolAssetClass(nextSymbol) : null }
}

export function validateAssetClassConsistency(
  symbol: string | undefined,
  assetClass: string | undefined,
): PolicyValidation {
  if (!symbol || !assetClass) return { ok: true, assetClass: symbol ? detectSymbolAssetClass(symbol) : null }
  const detected = detectSymbolAssetClass(symbol)
  if (assetClass === "option" && detected !== "option") {
    return {
      ok: false,
      code: "OPTIONS_WITH_EQUITY_PROXY_SYMBOL",
      message:
        `Config declares asset_class "option" but symbol "${symbol}" is not an option contract. ` +
        `Keep the option symbol as-is and use backtest.proxy_symbol for any explicit underlying proxy run.`,
      assetClass: detected,
    }
  }
  if (detected && detected !== assetClass) {
    return {
      ok: false,
      code: "BROKER_SYMBOL_MISMATCH",
      message: `Config asset_class "${assetClass}" does not match symbol "${symbol}" (${detected}).`,
      assetClass: detected,
    }
  }
  return { ok: true, assetClass: detected }
}
