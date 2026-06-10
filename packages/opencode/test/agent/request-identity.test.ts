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
