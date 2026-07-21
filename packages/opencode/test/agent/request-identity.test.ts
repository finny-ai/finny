import { describe, expect, test } from "bun:test"
import {
  parseRequestFacts,
  parseRequestIdentityProposal,
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
    expect(normalizeInterval("weekly")).toBe("1w")
    expect(normalizeInterval("five-minute")).toBe("5m")
    expect(normalizeInterval("thirty minutes")).toBe("30m")
    expect(normalizeInterval("(15m)")).toBe("15m")
  })
})

describe("request identity proposals", () => {
  test("does not bind market or region prose as a ticker", () => {
    const prompts = [
      "Research a liquid US-market opportunity and choose the instrument.",
      "Find an EMEA equity opportunity without choosing a symbol yet.",
      "Compare UK and EU markets, then delegate the instrument choice.",
      "Research APAC stocks and propose a liquid vehicle.",
    ]
    for (const prompt of prompts) {
      const proposal = parseRequestIdentityProposal(prompt)
      expect(proposal.status).toBe("proposed")
      expect(proposal.facts.requested_symbol).toBeUndefined()
      expect(proposal.facts.requested_symbols).toBeUndefined()
    }
  })

  test("confirms an exact explicit SPY token", () => {
    expect(parseRequestIdentityProposal("Build and backtest SPY equity on 1d bars.")).toMatchObject({
      status: "confirmed",
      confidence: 1,
      facts: { requested_symbol: "SPY", requested_asset_class: "equity", requested_interval: "1d" },
    })
  })
})

describe("parseRequestFacts", () => {
  test("preserves a bare regional listing with its exchange suffix", () => {
    expect(parseRequestFacts("RELIANCE.NS 1hr")).toMatchObject({
      requested_symbol: "RELIANCE.NS",
      requested_interval: "1h",
      requested_asset_class: "equity",
    })
  })

  test("parses terse ticker and compact minute requests", () => {
    expect(parseRequestFacts("VFV 15min")).toMatchObject({
      requested_symbol: "VFV",
      requested_interval: "15m",
      requested_asset_class: "equity",
    })
  })

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

  test("preserves the exact listing in exchange-qualified regional symbols", () => {
    const facts = parseRequestFacts("Build a daily swing strategy for Kraken Robotics (TSXV:PNG).")
    expect(facts.requested_symbol).toBe("PNG.V")
    expect(facts.requested_asset_class).toBe("equity")
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

  test("does not mistake OHLCV for the symbol in historical data prompts", () => {
    const facts = parseRequestFacts(
      "Extract historical OHLCV data for BTC covering the last 2 years with a 1d interval.",
    )
    expect(facts.requested_symbol).toBe("BTC")
    expect(facts.requested_interval).toBe("1d")
    expect(facts.requested_asset_class).toBe("crypto")
  })

  test("scopes bare daily interval parsing to timeframe context", () => {
    expect(parseRequestFacts("SOL daily market data").requested_interval).toBe("1d")
    expect(parseRequestFacts("Build a SOL daily strategy with max drawdown 10%.").requested_interval).toBe("1d")
    expect(parseRequestFacts("Build SPY with max daily drawdown 2%.").requested_interval).toBeUndefined()
    expect(parseRequestFacts("Build SPY with daily risk limit 2%.").requested_interval).toBeUndefined()
  })

  test("does not let indicator lookbacks override the bar interval", () => {
    const audit = parseRequestFacts("Build a daily AAPL strategy using a 20-day SMA and test it for leakage.")
    expect(audit.requested_symbol).toBe("AAPL")
    expect(audit.requested_interval).toBe("1d")

    expect(parseRequestFacts("15-minute SPY with a 20-day volatility filter").requested_interval).toBe("15m")
    expect(parseRequestFacts("SPY timeframe: 1h using a 14-day RSI").requested_interval).toBe("1h")
    expect(parseRequestFacts("SPY on daily candles with a 21-day EMA").requested_interval).toBe("1d")
  })

  test("treats explicit bar language as interval identity", () => {
    expect(parseRequestFacts("AAPL on 20-day bars").requested_interval).toBe("20d")
    expect(parseRequestFacts("SPY with interval=4h and a 60-minute ATR window").requested_interval).toBe("4h")
    expect(parseRequestFacts("Use 15-minute candles for SPY with rolling 20-day statistics").requested_interval).toBe(
      "15m",
    )
  })

  test("leaves isolated feature horizons ambiguous instead of treating them as bars", () => {
    expect(parseRequestFacts("Build AAPL using a 20-day SMA").requested_interval).toBeUndefined()
    expect(parseRequestFacts("Build SPY using 14-day RSI and 20-day ATR").requested_interval).toBeUndefined()
    expect(parseRequestFacts("Model SPY with 60-minute volatility").requested_interval).toBeUndefined()
  })

  test("does not treat ordinary strategy words as SMA/window feature horizons", () => {
    expect(parseRequestFacts("Build a 1d small-cap momentum strategy for IWM").requested_interval).toBe("1d")
    expect(parseRequestFacts("Build SPY 15m smart beta mean reversion").requested_interval).toBe("15m")
  })

  test("propagates explicit bar context across comma-separated alternatives", () => {
    expect(parseRequestFacts("Prefer 1h, 4h, or 1d bars for SPY momentum").requested_interval).toBe("1h")
    expect(parseRequestFacts("Prefer 1h or 4h bars for SPY momentum").requested_interval).toBe("1h")
  })

  test("keeps explicitly labeled intervals even when feature words follow", () => {
    expect(parseRequestFacts("timeframe: 15-minute volatility breakout on SPY").requested_interval).toBe("15m")
    expect(parseRequestFacts("interval 15m RSI scalping on SPY").requested_interval).toBe("15m")
  })

  test("accepts spoken and compact bar intervals without inventing duration windows", () => {
    expect(parseRequestFacts("SPY five-minute strategy").requested_interval).toBe("5m")
    expect(parseRequestFacts("AAPL thirty minute bars").requested_interval).toBe("30m")
    expect(parseRequestFacts("trade TSLA on weekly bars").requested_interval).toBe("1w")
    expect(parseRequestFacts("Build SPY (15m) breakout").requested_interval).toBe("15m")
    expect(parseRequestFacts("SPY @ 5m with 200-day MA").requested_interval).toBe("5m")
    expect(parseRequestFacts("Use bar size 5 minutes for SPY").requested_interval).toBe("5m")
    expect(parseRequestFacts("20-day SMA crossover on daily AAPL").requested_interval).toBe("1d")
    expect(parseRequestFacts("Build SPY for the last 6 months").requested_interval).toBeUndefined()
    expect(parseRequestFacts("lookback period = 20 days for SPY").requested_interval).toBeUndefined()
    expect(parseRequestFacts("SPY with lookback of 20 days on 15m bars").requested_interval).toBe("15m")
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
