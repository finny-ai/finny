import { alpacaSpec, listAlpacaAccounts, readAlpacaCredentials } from "@/live/brokers/alpaca"

/** Inject Alpaca market-data env vars from Finny brokerage Auth storage (Settings → Brokerages). */
export async function resolveAlpacaMarketDataEnv(
  existing: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string> | null> {
  if (existing.ALPACA_API_KEY_ID && existing.ALPACA_API_SECRET_KEY) return null

  const accounts = await listAlpacaAccounts()
  const account = accounts[0]
  if (!account) return null

  const creds = await readAlpacaCredentials(account.providerID)
  if (!creds) return null

  return {
    ...alpacaSpec.envVars(creds),
    ALPACA_DATA_FEED: existing.ALPACA_DATA_FEED ?? "iex",
  }
}
