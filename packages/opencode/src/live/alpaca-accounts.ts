import crypto from "crypto"
import { Auth } from "@/auth"

export const ALPACA_PROVIDER_PREFIX = "alpaca-paper"

export interface AlpacaAccount {
  providerID: string
  label: string
  keyId: string
  endpoint: string
}

function isAlpacaKey(key: string): boolean {
  return key === ALPACA_PROVIDER_PREFIX || key.startsWith(`${ALPACA_PROVIDER_PREFIX}-`)
}

export function generateProviderID(): string {
  return `${ALPACA_PROVIDER_PREFIX}-${crypto.randomUUID()}`
}

export function maskKey(k: string): string {
  if (!k) return ""
  if (k.length <= 8) return k
  return k.slice(0, 4) + "…" + k.slice(-4)
}

export async function listAlpacaAccounts(): Promise<AlpacaAccount[]> {
  const all = await Auth.all()
  const accounts: AlpacaAccount[] = []
  for (const [key, info] of Object.entries(all)) {
    if (!isAlpacaKey(key)) continue
    if (info.type !== "api") continue
    const meta = (info as any).metadata ?? {}
    accounts.push({
      providerID: key,
      label: meta.label ?? "Default",
      keyId: meta.keyId ?? "",
      endpoint: meta.endpoint ?? "https://paper-api.alpaca.markets",
    })
  }
  return accounts
}

export async function readAlpacaCredentials(
  providerID: string,
): Promise<{ keyId: string; secret: string; endpoint: string } | null> {
  const info = await Auth.get(providerID)
  if (!info || info.type !== "api") return null
  const meta = (info as any).metadata ?? {}
  const keyId = meta.keyId
  if (!keyId || !info.key) return null
  return {
    keyId,
    secret: info.key,
    endpoint: meta.endpoint ?? "https://paper-api.alpaca.markets",
  }
}
