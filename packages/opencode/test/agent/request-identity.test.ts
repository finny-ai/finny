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

const SMH_EDGE_PROMPT =
  "I am market-aware and I want to test a stronger edge than broad SPY daily mean reversion. Use SMH as the traded symbol. Prefer 1h or 4h bars with semiconductor/AI leadership momentum."

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

  test("prefers an explicit traded symbol over a rejected baseline symbol", () => {
    const facts = parseRequestFacts(SMH_EDGE_PROMPT)
    expect(facts.requested_symbol).toBe("SMH")
    expect(facts.requested_interval).toBe("1h")
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("recognizes non-curated tickers only in high-confidence symbol contexts", () => {
    expect(parseRequestFacts("requested_symbol: SMH, interval 1h").requested_symbol).toBe("SMH")
    expect(parseRequestFacts("target vehicle SMH with 1h bars").requested_symbol).toBe("SMH")
    expect(parseRequestFacts("Review AI SEMI leadership without choosing a symbol").requested_symbol).toBeUndefined()
  })

  test("downranks instead-of symbols in favor of the requested replacement", () => {
    const facts = parseRequestFacts("Instead of SPY, use QQQ for the 1h momentum strategy.")
    expect(facts.requested_symbol).toBe("QQQ")
    expect(facts.requested_interval).toBe("1h")
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("does not treat generic use of an indicator as an unknown ticker", () => {
    const facts = parseRequestFacts("Build a SPY mean reversion strategy. Use RSI for entries on 15m bars.")
    expect(facts.requested_symbol).toBe("SPY")
    expect(facts.requested_interval).toBe("15m")
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
    expect(
      parseRequestFacts('Build is improving algorithm "spy-1h-momentum-breakout" for SPY 1h.').requested_algorithm_name,
    ).toBe("spy-1h-momentum-breakout")
    expect(
      parseRequestFacts("Build is improving strategy 'spy-1h-momentum-breakout' for SPY 1h.").requested_algorithm_name,
    ).toBe("spy-1h-momentum-breakout")
    expect(
      parseRequestFacts('Build is improving algorithm `spy-1h-momentum-breakout" for SPY 1h.').requested_algorithm_name,
    ).toBeUndefined()
    expect(parseRequestFacts("Strategy family momentum breakout for SPY 1h.").requested_algorithm_name).toBeUndefined()
  })

  test("extracts explicit multi-stock universes without narrowing to a stale single symbol", () => {
    const facts = parseRequestFacts("requested Trump-linked stock universe DJT,RUM,GEO,CXW on 1d equities")
    expect(facts.requested_symbols).toEqual(["DJT", "RUM", "GEO", "CXW"])
    expect(facts.requested_symbol).toBeUndefined()
    expect(facts.requested_interval).toBe("1d")
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("does not parse the asset-class word after a ticker list as a partial ticker", () => {
    const facts = parseRequestFacts("portfolio universe/tickers DJT,RUM,GEO,CXW, equities, 1d swing")
    expect(facts.requested_symbols).toEqual(["DJT", "RUM", "GEO", "CXW"])
    expect(facts.requested_symbols).not.toContain("EQUITI")
    expect(facts.requested_interval).toBe("1d")
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("does not parse lowercase digest prose as a comma-separated ticker universe", () => {
    const facts = parseRequestFacts(
      "Extract daily (1d) OHLCV data for DJT. Return a digest with usable_for_parent: yes or usable_for_parent: no, the requested vs actual coverage, gap counts, and quality notes.",
    )
    expect(facts.requested_symbol).toBe("DJT")
    expect(facts.requested_symbols).toBeUndefined()
    expect(facts.requested_interval).toBe("1d")
  })

  test("does not overwrite explicit single tickers with lowercase asset prose", () => {
    const facts = parseRequestFacts(
      "Extract daily OHLCV data for RUM from 2026-01-01 to 2026-06-29. requested_symbol: RUM, requested_interval: 1d, requested_asset_class: equities.",
    )
    expect(facts.requested_symbol).toBe("RUM")
    expect(facts.requested_symbols).toBeUndefined()
    expect(facts.requested_asset_class).toBe("equity")
    expect(facts.requested_interval).toBe("1d")
  })

  test("does not parse macro news acronyms as stock identity", () => {
    const facts = parseRequestFacts(
      "Research FOMC, CPI, and election risk-regime events for the Trump trade. The target stocks are DJT,RUM,GEO,CXW.",
    )
    expect(facts.requested_symbols).toEqual(["DJT", "RUM", "GEO", "CXW"])
    expect(facts.requested_symbol).toBeUndefined()
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("does not parse broker and indicator prose as the ticker universe", () => {
    const facts = parseRequestFacts(
      "Build a new SPY 15-minute equity strategy for IBKR, RSI mean-reversion, long-only. Immutable identity: requested_symbol=SPY, requested_interval=15min, requested_asset_class=equity/equities, requested_algorithm_name=NONE_NEW_REQUEST, requested_start=2026-04-02, requested_end=2026-07-02, capital=10000.",
    )
    expect(facts.requested_symbol).toBe("SPY")
    expect(facts.requested_symbols).toBeUndefined()
    expect(facts.requested_interval).toBe("15m")
    expect(facts.requested_asset_class).toBe("equity")
  })

  test("resolves the traded symbol when broker and indicator lead the sentence", () => {
    const facts = parseRequestFacts("Build an IBKR, RSI mean-reversion strategy on SPY 15min bars, long-only.")
    expect(facts.requested_symbol).toBe("SPY")
    expect(facts.requested_symbols).toBeUndefined()
  })

  test("keeps keyword-anchored universes even when they contain ambiguous acronyms", () => {
    const facts = parseRequestFacts("backtest the basket symbols: IBKR, RSI on 1d bars")
    expect(facts.requested_symbols).toEqual(["IBKR", "RSI"])
  })

  test("keeps unkeyed universes when the explicit symbol is part of the list", () => {
    const facts = parseRequestFacts("Trade AAPL, MSFT daily with equal weight")
    expect(facts.requested_symbols).toEqual(["AAPL", "MSFT"])
  })

  test("still accepts ambiguous acronyms as tickers in keyed single-symbol form", () => {
    const facts = parseRequestFacts("Build a 1d strategy. ticker: RSI (Rush Street Interactive)")
    expect(facts.requested_symbol).toBe("RSI")
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

  test("accepts a symbol that belongs to the requested universe and blocks one outside it", () => {
    const universe = {
      requested_symbols: ["DJT", "RUM", "GEO", "CXW"],
      requested_interval: "1d",
      requested_asset_class: "equity",
    } satisfies RequestFacts
    expect(
      verifyIdentity(universe, { actual_symbol: "RUM", actual_interval: "1d", actual_asset_class: "equity" }).ok,
    ).toBe(true)
    const blocked = verifyIdentity(universe, {
      actual_symbol: "ES",
      actual_interval: "1d",
      actual_asset_class: "equity",
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe("symbol mismatch")
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
