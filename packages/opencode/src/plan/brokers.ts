import { Plan } from "."

/**
 * Minimum tier required to use each brokerage for LIVE trading.
 * Paper trading is unrestricted across all brokerages and tiers — do not
 * consult this map from paper-trading code paths.
 *
 * Forward-compatible: includes brokerages not yet integrated (polymarket,
 * questrade, ibkr) so when they land their gate is already in place.
 */
export const BROKER_MIN_TIER: Record<string, Plan.Tier> = {
  alpaca: "lite",
  binance: "lite",
  polymarket: "lite",
  questrade: "pro",
  ibkr: "pro",
}

/**
 * Throws Plan.PlanLimitError if the current user tier cannot trade live on
 * the given brokerage. Call from the live entry path only.
 */
export async function requireBrokerTier(brokerKind: string): Promise<void> {
  const required = BROKER_MIN_TIER[brokerKind] ?? "lite"
  await Plan.requireTier(required, `live_brokerage:${brokerKind}`)
}
