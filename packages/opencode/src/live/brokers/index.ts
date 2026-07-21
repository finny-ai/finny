import type { AssetClass, BrokerAccount, BrokerCredentials, BrokerKind, BrokerSpec, PythonDep } from "./types"
import { alpacaSpec, generateAlpacaProviderID, listAlpacaAccounts, readAlpacaCredentials } from "./alpaca"
import { binanceSpec, generateBinanceProviderID, listBinanceAccounts, readBinanceCredentials } from "./binance"
import { ibkrSpec, generateIbkrProviderID, listIbkrAccounts, readIbkrCredentials } from "./ibkr"
import {
  REGIONAL_BROKER_SPECS,
  generateRegionalProviderID,
  listRegionalAccounts,
  readRegionalCredentials,
} from "./regional"

export type {
  BrokerAccount,
  BrokerConnection,
  BrokerCredentials,
  BrokerKind,
  BrokerMode,
  BrokerSpec,
  PythonDep,
} from "./types"
export { BROKER_KINDS } from "./types"
export { ALPACA_PROVIDER_PREFIX } from "./alpaca"
export { BINANCE_PROVIDER_PREFIX } from "./binance"
export { IBKR_PROVIDER_PREFIX } from "./ibkr"
export { futuSpec, questradeSpec, saxoSpec, zerodhaSpec } from "./regional"

const SPECS: Record<BrokerKind, BrokerSpec> = {
  alpaca: alpacaSpec,
  binance: binanceSpec,
  ibkr: ibkrSpec,
  ...REGIONAL_BROKER_SPECS,
}

export namespace BrokerRegistry {
  export function getSpec(kind: BrokerKind): BrokerSpec {
    const spec = SPECS[kind]
    if (!spec) throw new Error(`Unknown broker kind: ${kind}`)
    return spec
  }

  export function specs(): BrokerSpec[] {
    return Object.values(SPECS).filter(Boolean)
  }

  export function detectKind(providerID: string): BrokerKind | null {
    for (const spec of specs()) {
      if (providerID === spec.providerPrefix || providerID.startsWith(`${spec.providerPrefix}-`)) {
        return spec.kind
      }
    }
    return null
  }

  export function generateProviderID(kind: BrokerKind): string {
    if (kind === "alpaca") return generateAlpacaProviderID()
    if (kind === "binance") return generateBinanceProviderID()
    if (kind === "ibkr") return generateIbkrProviderID()
    if (kind === "zerodha" || kind === "saxo" || kind === "questrade" || kind === "futu") {
      return generateRegionalProviderID(kind)
    }
    throw new Error(`generateProviderID not implemented for ${kind}`)
  }

  export async function listAccounts(kind?: BrokerKind): Promise<BrokerAccount[]> {
    const all: BrokerAccount[] = []
    if (!kind || kind === "alpaca") all.push(...(await listAlpacaAccounts()))
    if (!kind || kind === "binance") all.push(...(await listBinanceAccounts()))
    if (!kind || kind === "ibkr") all.push(...(await listIbkrAccounts()))
    if (!kind || kind === "zerodha") all.push(...(await listRegionalAccounts("zerodha")))
    if (!kind || kind === "saxo") all.push(...(await listRegionalAccounts("saxo")))
    if (!kind || kind === "questrade") all.push(...(await listRegionalAccounts("questrade")))
    if (!kind || kind === "futu") all.push(...(await listRegionalAccounts("futu")))
    return all
  }

  export async function readCredentials(providerID: string): Promise<BrokerCredentials | null> {
    const kind = detectKind(providerID)
    if (!kind) return null
    if (kind === "alpaca") return readAlpacaCredentials(providerID)
    if (kind === "binance") return readBinanceCredentials(providerID)
    if (kind === "ibkr") return readIbkrCredentials(providerID)
    if (kind === "zerodha" || kind === "saxo" || kind === "questrade" || kind === "futu") {
      return readRegionalCredentials(kind, providerID)
    }
    return null
  }

  export interface BrokerComparison {
    spec: BrokerSpec
    supports: boolean
    nativeSymbol: string
    assetClass: AssetClass | null
    takerFee: number
    accounts: BrokerAccount[]
  }

  export async function compareForSymbol(canonicalSymbol: string): Promise<BrokerComparison[]> {
    const allAccounts = await listAccounts()
    return specs().map((spec) => {
      const assetClass = spec.detectAssetClass(canonicalSymbol)
      const supports = assetClass !== null && spec.assetClasses.includes(assetClass)
      return {
        spec,
        supports,
        nativeSymbol: supports ? spec.resolvePair(canonicalSymbol) : canonicalSymbol,
        assetClass,
        takerFee: spec.staticTakerFee,
        accounts: allAccounts.filter((a) => a.brokerKind === spec.kind),
      }
    })
  }

  export function unionPythonDeps(): PythonDep[] {
    const seen = new Map<string, PythonDep>()
    for (const spec of specs()) {
      for (const dep of spec.pythonDeps) {
        seen.set(dep.importCheck, dep)
      }
    }
    return Array.from(seen.values())
  }
}
