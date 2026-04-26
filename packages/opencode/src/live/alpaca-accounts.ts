// Compatibility shim. The implementation lives in `./brokers/alpaca.ts`;
// this file preserves the legacy import paths for callers that have not yet
// been migrated to the BrokerRegistry.
import {
  ALPACA_PROVIDER_PREFIX,
  generateAlpacaProviderID,
  listAlpacaAccounts as listAccounts,
  readAlpacaCredentials as readCreds,
} from "./brokers/alpaca"
import type { BrokerAccount, BrokerCredentials } from "./brokers/types"

export { ALPACA_PROVIDER_PREFIX }

export interface AlpacaAccount {
  providerID: string
  label: string
  keyId: string
  endpoint: string
}

export function generateProviderID(): string {
  return generateAlpacaProviderID()
}

export function maskKey(k: string): string {
  if (!k) return ""
  if (k.length <= 8) return k
  return k.slice(0, 4) + "…" + k.slice(-4)
}

export async function listAlpacaAccounts(): Promise<AlpacaAccount[]> {
  const accounts = await listAccounts()
  return accounts.map((a: BrokerAccount) => ({
    providerID: a.providerID,
    label: a.label,
    keyId: a.keyId,
    endpoint: a.endpoint,
  }))
}

export async function readAlpacaCredentials(
  providerID: string,
): Promise<{ keyId: string; secret: string; endpoint: string } | null> {
  const c = await readCreds(providerID)
  if (!c) return null
  const out: BrokerCredentials = c
  return out
}
