import { describe, expect, test } from "bun:test"
import { AlpacaData } from "../../src/cron/alpaca-data"

describe("AlpacaData.tradingURL", () => {
  test("joins a clean endpoint with a versioned path", () => {
    expect(AlpacaData.tradingURL("https://paper-api.alpaca.markets", "/v2/account")).toBe(
      "https://paper-api.alpaca.markets/v2/account",
    )
  })

  test("strips a trailing slash before joining", () => {
    expect(AlpacaData.tradingURL("https://paper-api.alpaca.markets/", "/v2/account")).toBe(
      "https://paper-api.alpaca.markets/v2/account",
    )
  })

  test("strips a trailing /v2 the user pasted into the endpoint field", () => {
    // This is the regression: users storing the endpoint as
    // `https://paper-api.alpaca.markets/v2` produced `/v2/v2/account` 404s.
    expect(AlpacaData.tradingURL("https://paper-api.alpaca.markets/v2", "/v2/account")).toBe(
      "https://paper-api.alpaca.markets/v2/account",
    )
  })

  test("strips a trailing /v1 too (forward-compat)", () => {
    expect(AlpacaData.tradingURL("https://paper-api.alpaca.markets/v1", "/v2/positions/AAPL")).toBe(
      "https://paper-api.alpaca.markets/v2/positions/AAPL",
    )
  })

  test("tolerates a path that does not start with a slash", () => {
    expect(AlpacaData.tradingURL("https://paper-api.alpaca.markets", "v2/account")).toBe(
      "https://paper-api.alpaca.markets/v2/account",
    )
  })

  test("strips both trailing slash and trailing /v2 in combination", () => {
    expect(AlpacaData.tradingURL("https://paper-api.alpaca.markets/v2/", "/v2/account")).toBe(
      "https://paper-api.alpaca.markets/v2/account",
    )
  })
})
