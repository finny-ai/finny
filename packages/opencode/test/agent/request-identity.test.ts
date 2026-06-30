import { describe, expect, test } from "bun:test"
import {
  parseRequestFacts,
  verifyIdentity,
  normalizeSymbol,
  normalizeInterval,
  type RequestFacts,
} from "../../src/agent/request-identity"

const SPY_REQUEST: RequestFacts = {
  requested_symbol: "SPY",
  requested_interval: "15m",
  requested_asset_class: "equity",
}

describe("request identity normalization", () => {
  test("collapses symbols to bare ticker", () => {
    expect(normalizeSymbol("BTC/USD")).toBe("BTC")
    expect(normalizeSymbol("btc-usdt")).toBe("BTC")
    expect(normalizeSymbol("SPY")).toBe("SPY")
  })

  test("canonicalizes intervals", () => {
    expect(normalizeInterval("15min")).toBe("15m")
    expect(normalizeInterval("15-minute")).toBe("15m")
    expect(normalizeInterval("5 m")).toBe("5m")
    expect(normalizeInterval("60m")).toBe("1h")
    expect(normalizeInterval("1 hour")).toBe("1h")
    expect(normalizeInterval("daily")).toBe("1d")
    expect(normalizeInterval("hourly")).toBe("1h")
  })
})

describe("parseRequestFacts", () => {
  test("extracts immutable facts from the vague SPY prompt", () => {
    const facts = parseRequestFacts(
      "Build a new SPY 15-minute mean reversion strategy with $10,000 over 3 months. Keep it clean and validate/backtest it in strict mode.",
    )
    expect(facts.requested_symbol).toBe("SPY")
    expect(facts.requested_interval).toBe("15m")
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("extracts immutable facts from a compact strategy slug", () => {
    const facts = parseRequestFacts("spy-5m-momentum")
    expect(facts.requested_symbol).toBe("SPY")
    expect(facts.requested_interval).toBe("5m")
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("extracts bare daily interval from terse crypto prompts", () => {
    const facts = parseRequestFacts("SOL daily")
    expect(facts.requested_symbol).toBe("SOL")
    expect(facts.requested_interval).toBe("1d")
    expect(facts.requested_asset_class).toBe("crypto")
  })

  test("scopes bare daily interval parsing to timeframe context", () => {
    expect(parseRequestFacts("SOL daily market data").requested_interval).toBe("1d")
    expect(parseRequestFacts("Build a SOL daily strategy with max drawdown 10%.").requested_interval).toBe("1d")
    expect(parseRequestFacts("Build SPY with max daily drawdown 2%.").requested_interval).toBeUndefined()
    expect(parseRequestFacts("Build SPY with daily risk limit 2%.").requested_interval).toBeUndefined()
  })

  test("preserves crypto pair recognition inside compact slugs", () => {
    const facts = parseRequestFacts("btc-usdt-5m-momentum")
    expect(facts.requested_symbol).toBe("BTC")
    expect(facts.requested_interval).toBe("5m")
    expect(facts.requested_asset_class).toBe("crypto")
  })

  test("extracts explicitly requested algorithm names without using generic slugs", () => {
    const facts = parseRequestFacts("Build SPY 5-minute equity. Name it spy-5m-product-demo-20260614-v2.")
    expect(facts.requested_symbol).toBe("SPY")
    expect(facts.requested_interval).toBe("5m")
    expect(facts.requested_algorithm_name).toBe("spy-5m-product-demo-20260614-v2")
    expect(parseRequestFacts("spy-5m-momentum").requested_algorithm_name).toBeUndefined()
  })

  test("extracts explicit existing algorithm names from follow-up task prompts", () => {
    const facts = parseRequestFacts(
      "Data request context: Build is improving EXISTING algorithm `spy-1h-momentum-breakout` v2 for SPY ETF, interval 1h.",
    )
    expect(facts.requested_symbol).toBe("SPY")
    expect(facts.requested_interval).toBe("1h")
    expect(facts.requested_algorithm_name).toBe("spy-1h-momentum-breakout")
    expect(parseRequestFacts('Build is improving algorithm "spy-1h-momentum-breakout" for SPY 1h.').requested_algorithm_name).toBe(
      "spy-1h-momentum-breakout",
    )
    expect(parseRequestFacts("Build is improving strategy 'spy-1h-momentum-breakout' for SPY 1h.").requested_algorithm_name).toBe(
      "spy-1h-momentum-breakout",
    )
    expect(parseRequestFacts('Build is improving algorithm `spy-1h-momentum-breakout" for SPY 1h.').requested_algorithm_name).toBeUndefined()
    expect(parseRequestFacts("Strategy family momentum breakout for SPY 1h.").requested_algorithm_name).toBeUndefined()
  })
})

describe("verifyIdentity", () => {
  test("accepts a matching SPY / 15min / equity artifact", () => {
    const result = verifyIdentity(SPY_REQUEST, {
      actual_symbol: "SPY",
      actual_interval: "15m",
      actual_asset_class: "equity",
      algorithm_name: "spy-15m-mean-reversion",
      run_id: "abc-123",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("ok")
  })

  test("blocks the observed leak: SPY data but a btc-usdt-5m-momentum note", () => {
    const result = verifyIdentity(SPY_REQUEST, {
      actual_symbol: "SPY",
      actual_interval: "15m",
      actual_asset_class: "equity",
      // The data is SPY, but the surrounding artifact belongs to a foreign algo.
      algorithm_name: "btc-usdt-5m-momentum",
      run_id: "abc-123",
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("blocked")
    expect(result.blocked).toBe(
      "BLOCKED: context mismatch — requested SPY 15min equity but subagent/artifact references btc-usdt-5m-momentum.",
    )
  })

  test("blocks a symbol mismatch outright", () => {
    const result = verifyIdentity(SPY_REQUEST, {
      actual_symbol: "BTC/USD",
      actual_interval: "15m",
      actual_asset_class: "crypto",
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("blocked")
    expect(result.blocked).toContain("BLOCKED: context mismatch")
  })

  test("blocks an interval mismatch", () => {
    const result = verifyIdentity(SPY_REQUEST, {
      actual_symbol: "SPY",
      actual_interval: "5m",
      actual_asset_class: "equity",
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("blocked")
  })

  test("blocks an asset class mismatch", () => {
    const result = verifyIdentity(
      { requested_symbol: "BTC", requested_interval: "5m", requested_asset_class: "crypto" },
      { actual_symbol: "SPY", actual_interval: "5m", actual_asset_class: "equity" },
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe("blocked")
  })

  test("treats missing identity metadata as insufficient, not usable", () => {
    const result = verifyIdentity(SPY_REQUEST, {})
    expect(result.ok).toBe(false)
    expect(result.status).toBe("insufficient")
  })
})
