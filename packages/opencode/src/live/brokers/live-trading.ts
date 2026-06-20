import type { BrokerCredentials, BrokerMode, BrokerSpec } from "./types"

const DISABLED_VALUES = new Set(["false", "0", "no", "off"])

export function liveTradingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FINNY_LIVE_TRADING?.trim().toLowerCase()
  return value === undefined || !DISABLED_VALUES.has(value)
}

export function brokerModeChoices(modes: readonly BrokerMode[], env: NodeJS.ProcessEnv = process.env): BrokerMode[] {
  if (liveTradingEnabled(env)) return [...modes]
  return modes.filter((mode) => mode !== "live")
}

function normalizeEndpoint(endpoint: string | undefined): string {
  return (endpoint ?? "").trim().replace(/^tcp:\/\//i, "").replace(/\/+$/, "").toLowerCase()
}

export function liveTradingDisabledReason(
  spec: BrokerSpec,
  creds: BrokerCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (liveTradingEnabled(env)) return null
  if (creds.mode === "live") return `${spec.displayName} live trading is disabled. Set FINNY_LIVE_TRADING=true to enable live mode.`

  const mode = creds.mode ?? spec.mode
  const expectedEndpoint = spec.endpointForMode?.(mode)
  if (expectedEndpoint && normalizeEndpoint(creds.endpoint) !== normalizeEndpoint(expectedEndpoint)) {
    return `${spec.displayName} custom endpoints are disabled while FINNY_LIVE_TRADING=false. Use the default ${mode} endpoint or set FINNY_LIVE_TRADING=true.`
  }

  return null
}
