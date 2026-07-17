import { describe, expect, test } from "bun:test"
import {
  DEFAULT_BINANCE_BASE_URL,
  resolveBinanceBaseUrl,
} from "../../src/data/binance-market-data-env"

describe("Binance market-data environment", () => {
  test("uses the public market-data endpoint without user configuration", () => {
    expect(resolveBinanceBaseUrl({})).toBe(DEFAULT_BINANCE_BASE_URL)
    expect(DEFAULT_BINANCE_BASE_URL).toBe("https://data-api.binance.vision")
  })

  test("preserves an explicit managed or user endpoint override", () => {
    expect(resolveBinanceBaseUrl({ BINANCE_BASE_URL: " https://example.test " })).toBe("https://example.test")
  })
})
