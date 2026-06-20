import { afterEach, describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { resolveAlpacaMarketDataEnv } from "../../src/data/alpaca-market-data-env"
import { generateAlpacaProviderID } from "../../src/live/brokers/alpaca"

describe("resolveAlpacaMarketDataEnv", () => {
  let providerID = ""

  afterEach(async () => {
    if (providerID) {
      await Auth.remove(providerID)
      providerID = ""
    }
  })

  test("returns null when env already has Alpaca keys", async () => {
    const result = await resolveAlpacaMarketDataEnv({
      ALPACA_API_KEY_ID: "existing",
      ALPACA_API_SECRET_KEY: "existing",
    })
    expect(result).toBeNull()
  })

  test("loads keys from connected Alpaca brokerage auth storage", async () => {
    providerID = generateAlpacaProviderID()
    await Auth.set(providerID, {
      type: "api",
      key: "stored_secret",
      metadata: {
        keyId: "stored_key_id",
        label: "Paper",
        mode: "paper",
      },
    })

    const result = await resolveAlpacaMarketDataEnv({})
    expect(result).toEqual({
      ALPACA_API_KEY_ID: "stored_key_id",
      ALPACA_API_SECRET_KEY: "stored_secret",
      ALPACA_ENDPOINT: "https://paper-api.alpaca.markets",
      ALPACA_MODE: "paper",
      ALPACA_DATA_FEED: "iex",
    })
  })
})
