export const BROKER_KINDS = [
  "alpaca",
  "binance",
  "ibkr",
  "zerodha",
  "saxo",
  "questrade",
  "futu",
  "robinhood",
  "qc",
] as const
export type BrokerKind = (typeof BROKER_KINDS)[number]
export type AssetClass = "equity" | "crypto" | "option" | "future"
export type BrokerMode = "paper" | "testnet" | "live"
export type BrokerConnection = "tws" | "gateway"

export interface BrokerAccount {
  providerID: string
  brokerKind: BrokerKind
  label: string
  keyId: string
  endpoint: string
  mode?: BrokerMode
  connection?: BrokerConnection
  /** Optional verified asset classes for connectors with separate auth domains. */
  assetClasses?: AssetClass[]
}

export interface BrokerCredentials {
  keyId: string
  secret: string
  endpoint: string
  mode?: BrokerMode
  connection?: BrokerConnection
}

export interface CredentialField {
  name: "keyId" | "secret" | "endpoint" | "label" | "mode" | "connection"
  label: string
  placeholder?: string
  secret?: boolean
  required?: boolean
  default?: string
  choices?: string[]
}

export interface PythonDep {
  spec: string
  importCheck: string
}

export interface BrokerSpec {
  kind: BrokerKind
  displayName: string
  mode: BrokerMode
  providerPrefix: string
  pythonClass: string
  pythonDeps: PythonDep[]
  assetClasses: AssetClass[]
  staticTakerFee: number
  defaultEndpoint: string
  docsUrl: string
  credentialFields: CredentialField[]
  promptFragment: string
  /** Regional data-only connectors are selectable for research but cannot start execution workers. */
  executionSupport?: "enabled" | "data_only"
  normalizeSymbol(canonical: string): string
  resolvePair(canonical: string): string
  detectAssetClass(canonical: string): AssetClass | null
  envVars(creds: BrokerCredentials): Record<string, string>
  // Optional. Returns the canonical endpoint for a mode and optional credential
  // context. Used by the add-account dialog and live-trading guardrails to keep
  // default endpoints in sync while preserving custom endpoints after edits.
  endpointForMode?(mode: BrokerMode, creds?: Pick<BrokerCredentials, "connection">): string
}
