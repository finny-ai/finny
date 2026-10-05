import { resolveSymbol } from "../../src/data/symbols"

export function canonicalSymbol(value: unknown): string {
  const symbol = String(value ?? "")
    .trim()
    .toUpperCase()
  return resolveSymbol(symbol)?.canonical ?? symbol
}

export function canonicalAssetClass(value: unknown): string {
  const asset = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
  if (asset === "equities") return "equity"
  // The workspace uses crypto; the execution profile spells spot explicitly.
  // Derivative profiles retain their distinct identity.
  return asset === "crypto" ? "crypto-spot" : asset
}

export function canonicalInterval(value: unknown): string {
  const interval = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
  return ["5min", "5mins", "5minute", "5minutes"].includes(interval) ? "5m" : interval
}

export function canonicalStrategyFamily(value: unknown): string {
  const family = String(value ?? "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
  return family === "golden-cross" ? "sma-crossover" : family
}
