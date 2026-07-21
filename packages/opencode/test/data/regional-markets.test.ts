import { describe, expect, test } from "bun:test"
import { parseRequestFacts } from "../../src/agent/request-identity"
import { resolveSymbol } from "../../src/data/symbols"
import { normalizeRegionalTicker, regionalMarketForTicker, regionalNativeSymbol } from "../../src/data/regional-markets"
import { BrokerRegistry } from "../../src/live/brokers"
import { validateSymbolForBroker } from "../../src/live/brokers/policy"

describe("regional equity routing", () => {
  test.each([
    ["RELIANCE.NS", "zerodha", "NSE:RELIANCE"],
    ["M&M.NS", "zerodha", "NSE:M&M"],
    ["SHOP.TO", "questrade", "SHOP.TO"],
    ["ASML.AS", "saxo", "ASML:xams"],
    ["600519.SS", "futu", "SH.600519"],
    ["0700.HK", "futu", "HK.00700"],
  ])("preserves %s and resolves its native brokerage symbol", (ticker, broker, native) => {
    expect(resolveSymbol(ticker)).toMatchObject({ canonical: ticker, yfinance: ticker, kind: "stock" })
    expect(regionalMarketForTicker(ticker)?.brokerKind as string | undefined).toBe(broker)
    expect(regionalNativeSymbol(ticker)).toBe(native)
    expect(validateSymbolForBroker(ticker, broker as any)).toMatchObject({ ok: true, normalizedSymbol: ticker })
  })

  test("normalizes exchange-qualified aliases without proxy substitution", () => {
    expect(normalizeRegionalTicker("NSE:RELIANCE")).toBe("RELIANCE.NS")
    expect(normalizeRegionalTicker("TSX:SHOP")).toBe("SHOP.TO")
    expect(normalizeRegionalTicker("SSE:600519")).toBe("600519.SS")
  })

  test("request identity retains the full regional listing", () => {
    expect(parseRequestFacts("Build a daily strategy for ticker RELIANCE.NS")).toMatchObject({
      requested_symbol: "RELIANCE.NS",
      requested_asset_class: "equity",
      requested_interval: "1d",
    })
    expect(parseRequestFacts("backtest NSE:RELIANCE on 1d bars").requested_symbol).toBe("RELIANCE.NS")
    expect(parseRequestFacts("ticker M&M.NS on daily bars").requested_symbol).toBe("M&M.NS")
  })

  test("registers regional data brokerages as execution-disabled", () => {
    expect(BrokerRegistry.specs().map((spec) => spec.kind)).toEqual([
      "alpaca",
      "binance",
      "ibkr",
      "zerodha",
      "saxo",
      "questrade",
      "futu",
    ])
    for (const kind of ["zerodha", "saxo", "questrade", "futu"] as const) {
      expect(BrokerRegistry.getSpec(kind).executionSupport).toBe("data_only")
    }
  })
})
