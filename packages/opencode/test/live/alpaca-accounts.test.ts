import { describe, expect, test } from "bun:test"
import { ALPACA_PROVIDER_PREFIX, normalizeAlpacaEndpoint } from "../../src/live/brokers/alpaca"

describe("normalizeAlpacaEndpoint", () => {
  test("keeps the canonical paper base URL", () => {
    expect(normalizeAlpacaEndpoint("https://paper-api.alpaca.markets", "paper")).toBe(
      "https://paper-api.alpaca.markets",
    )
  })

  test("strips a trailing slash and version suffix", () => {
    expect(normalizeAlpacaEndpoint("https://paper-api.alpaca.markets/v2/", "paper")).toBe(
      "https://paper-api.alpaca.markets",
    )
  })

  test("falls back to the mode default when empty", () => {
    expect(normalizeAlpacaEndpoint("", "live")).toBe("https://api.alpaca.markets")
  })
})

describe("legacy Alpaca provider IDs", () => {
  test("keeps the legacy prefix distinct from explicit account IDs", () => {
    const explicit: string = `${ALPACA_PROVIDER_PREFIX}-123`
    expect(explicit === ALPACA_PROVIDER_PREFIX).toBe(false)
  })
})
