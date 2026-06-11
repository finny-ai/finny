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
 * Local brokerage tier gates are disabled. Broker capability and credential
 * checks still happen in the live runner before a real brokerage connection.
 */
export async function requireBrokerTier(_brokerKind: string): Promise<void> {
  return
}
