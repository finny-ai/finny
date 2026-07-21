import { regionalMarketForTicker } from "./regional-markets"
import { BrokerRegistry } from "@/live/brokers"

/** Inject only the connected brokerage credentials matching the requested listing. */
export async function resolveRegionalMarketDataEnv(input: {
  symbol?: string
  existing?: NodeJS.ProcessEnv
}): Promise<Record<string, string> | null> {
  if (!input.symbol) return null
  const market = regionalMarketForTicker(input.symbol)
  if (!market) return null
  const accounts = await BrokerRegistry.listAccounts(market.brokerKind)
  const account = accounts[0]
  if (!account) return null
  const credentials = await BrokerRegistry.readCredentials(account.providerID)
  if (!credentials) return null
  const generated = BrokerRegistry.getSpec(market.brokerKind).envVars(credentials)
  const existing = input.existing ?? process.env
  return Object.fromEntries(Object.entries(generated).filter(([key]) => !existing[key]))
}
