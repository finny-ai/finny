/** Public, unauthenticated Binance market-data endpoint used by Data Agent. */
export const DEFAULT_BINANCE_BASE_URL = "https://data-api.binance.vision"

/**
 * Resolve the endpoint injected into every Data Agent shell. An explicit user
 * or managed environment override wins, but no per-machine setup is required.
 */
export function resolveBinanceBaseUrl(existing: NodeJS.ProcessEnv = process.env): string {
  return existing.BINANCE_BASE_URL?.trim() || DEFAULT_BINANCE_BASE_URL
}
