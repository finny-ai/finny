import { describe, expect, test } from "bun:test"
import { BacktestRunner } from "../../src/backtest/runner"

const { normalizeSymbol, classifyFetchError, UnknownSymbolError } = BacktestRunner

describe("normalizeSymbol", () => {
  test.each([
    ["BTC", "BTC/USD"],
    ["btc", "BTC/USD"],
    ["BTCUSD", "BTC/USD"],
    ["btcusd", "BTC/USD"],
    ["BTC-USD", "BTC/USD"],
    ["BTC/USD", "BTC/USD"],
    ["BTCUSDT", "BTC/USD"],
    ["btc/usdt", "BTC/USD"],
    ["BTC-USDC", "BTC/USD"],
  ])("collapses %s to BTC/USD", (input, expected) => {
    expect(normalizeSymbol(input)).toBe(expected)
  })

  test.each([
    ["ETH", "ETH/USD"],
    ["ETHUSD", "ETH/USD"],
    ["ETH-USD", "ETH/USD"],
    ["SOL", "SOL/USD"],
    ["SOLUSD", "SOL/USD"],
  ])("collapses other supported crypto: %s -> %s", (input, expected) => {
    expect(normalizeSymbol(input)).toBe(expected)
  })

  test.each([
    ["AAPL", "AAPL"],
    ["aapl", "AAPL"],
    ["NVDA", "NVDA"],
    ["TSLA", "TSLA"],
  ])("equity tickers passthrough: %s -> %s", (input, expected) => {
    expect(normalizeSymbol(input)).toBe(expected)
  })

  test("crypto bases canonicalize regardless of input form", () => {
    // XRP and DOGE are now in the curated SUPPORTED_SYMBOLS — they hit the
    // registry directly. XRPUSDT exercises the glued-pair fallback path
    // (Binance-style ticker → BASE/USD canonical).
    expect(normalizeSymbol("XRP")).toBe("XRP/USD")
    expect(normalizeSymbol("DOGE-USD")).toBe("DOGE/USD")
    expect(normalizeSymbol("XRPUSDT")).toBe("XRP/USD")
  })

  test("equity-shaped tokens outside the supported set passthrough as bare ticker", () => {
    expect(normalizeSymbol("UCO")).toBe("UCO")
    expect(normalizeSymbol("uco")).toBe("UCO")
    expect(normalizeSymbol("SPY")).toBe("SPY")
  })

  test.each([
    ["ES", "ES"],
    ["es", "ES"],
    ["ES=F", "ES"],
    ["NQ=F", "NQ"],
    ["6E=F", "6E"],
  ])("futures roots canonicalize: %s -> %s", (input, expected) => {
    expect(normalizeSymbol(input)).toBe(expected)
  })

  test("empty input throws UnknownSymbolError", () => {
    expect(() => normalizeSymbol("")).toThrow(UnknownSymbolError)
    expect(() => normalizeSymbol("   ")).toThrow(UnknownSymbolError)
  })

  test("garbage tokens throw UnknownSymbolError", () => {
    expect(() => normalizeSymbol("hello world!")).toThrow(UnknownSymbolError)
    expect(() => normalizeSymbol("12345678")).toThrow(UnknownSymbolError)
  })

  test("UnknownSymbolError carries suggestions", () => {
    try {
      normalizeSymbol("@@@")
      throw new Error("expected to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSymbolError)
      const err = e as InstanceType<typeof UnknownSymbolError>
      expect(err.suggestions).toContain("BTC/USD")
      expect(err.suggestions).toContain("AAPL")
    }
  })

  test("normalization is idempotent", () => {
    for (const s of ["BTCUSDT", "btc/usdt", "ETH-USD", "AAPL", "uco"]) {
      const once = normalizeSymbol(s)
      const twice = normalizeSymbol(once)
      expect(twice).toBe(once)
    }
  })
})

describe("classifyFetchError", () => {
  test("parses unknown_symbol sentinel", () => {
    const stderr = "__FINNY_FETCH_ERROR__: unknown_symbol: BTC-USDT: 404 Not Found"
    const { kind } = classifyFetchError(stderr)
    expect(kind).toBe("unknown_symbol")
  })

  test("parses empty_window sentinel", () => {
    const stderr = "__FINNY_FETCH_ERROR__: empty_window: BTC-USD: no bars between 2024-01-01 and 2024-01-02 at 1m"
    expect(classifyFetchError(stderr).kind).toBe("empty_window")
  })

  test("parses network sentinel", () => {
    const stderr = "__FINNY_FETCH_ERROR__: network: BTC-USD: Connection timeout"
    expect(classifyFetchError(stderr).kind).toBe("network")
  })

  test("parses python_env sentinel", () => {
    const stderr = "__FINNY_FETCH_ERROR__: python_env: yfinance import failed: No module named 'yfinance'"
    expect(classifyFetchError(stderr).kind).toBe("python_env")
  })

  test("falls back to substring heuristics when no sentinel", () => {
    expect(classifyFetchError("yfinance: 404 Symbol may be delisted").kind).toBe("unknown_symbol")
    expect(classifyFetchError("ConnectionError: Max retries exceeded").kind).toBe("network")
    expect(classifyFetchError("error: externally-managed-environment").kind).toBe("python_env")
    expect(classifyFetchError("ModuleNotFoundError: No module named 'pandas'").kind).toBe("python_env")
  })

  test("returns internal for completely unstructured stderr", () => {
    expect(classifyFetchError("segfault").kind).toBe("internal")
    expect(classifyFetchError("").kind).toBe("internal")
  })
})
