export type BrokerKind = "alpaca" | "binance"
export type AssetClass = "equity" | "crypto"
export type BrokerMode = "paper" | "testnet"

export interface BrokerAccount {
  providerID: string
  brokerKind: BrokerKind
  label: string
  keyId: string
  endpoint: string
}

export interface BrokerCredentials {
  keyId: string
  secret: string
  endpoint: string
}

export interface CredentialField {
  name: "keyId" | "secret" | "endpoint" | "label"
  label: string
  placeholder?: string
  secret?: boolean
  default?: string
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
  normalizeSymbol(canonical: string): string
  resolvePair(canonical: string): string
  detectAssetClass(canonical: string): AssetClass | null
  envVars(creds: BrokerCredentials): Record<string, string>
}
