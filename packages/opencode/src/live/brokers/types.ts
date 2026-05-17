export type BrokerKind = "alpaca" | "binance" | "ibkr"
export type AssetClass = "equity" | "crypto"
export type BrokerMode = "paper" | "testnet" | "live"

export interface BrokerAccount {
  providerID: string
  brokerKind: BrokerKind
  label: string
  keyId: string
  endpoint: string
  mode?: BrokerMode
}

export interface BrokerCredentials {
  keyId: string
  secret: string
  endpoint: string
  mode?: BrokerMode
}

export interface CredentialField {
  name: "keyId" | "secret" | "endpoint" | "label" | "mode"
  label: string
  placeholder?: string
  secret?: boolean
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
  normalizeSymbol(canonical: string): string
  resolvePair(canonical: string): string
  detectAssetClass(canonical: string): AssetClass | null
  envVars(creds: BrokerCredentials): Record<string, string>
  // Optional. Returns the default REST endpoint for a given mode. Used by the
  // add-account dialog to auto-update the endpoint field when the user
  // toggles paper/live/testnet. Specs that have a single endpoint regardless
  // of mode (e.g. IBKR's local Gateway) can leave this undefined.
  endpointForMode?(mode: BrokerMode): string
}
