import { describe, expect, test } from "bun:test"
import {
  parseTargetBrokerComment,
  validateAssetClassConsistency,
  validateOptionProxyMutation,
  validateSymbolForBroker,
} from "../../src/live/brokers/policy"

describe("broker policy helpers", () => {
  test("parses target broker comment from the first non-empty line", () => {
    expect(parseTargetBrokerComment('\n# Target broker: IBKR\nclass Strategy:\n    pass')).toBe("ibkr")
    expect(parseTargetBrokerComment("# Target broker: alpaca")).toBe("alpaca")
    expect(parseTargetBrokerComment("class Strategy:\n    pass")).toBeNull()
  })

  test("rejects option symbols on non-IBKR brokers", () => {
    const result = validateSymbolForBroker("SPY/20260619/500C", "alpaca")
    expect(result.ok).toBe(false)
    expect(result.code).toBe("OPTIONS_REQUIRE_IBKR")
  })

  test("accepts option symbols on IBKR", () => {
    const result = validateSymbolForBroker("SPY/20260619/500C", "ibkr")
    expect(result.ok).toBe(true)
    expect(result.assetClass).toBe("option")
  })

  test("rejects silent option-to-equity proxy mutations", () => {
    const result = validateOptionProxyMutation("SPY/20260619/500C", "SPY")
    expect(result.ok).toBe(false)
    expect(result.code).toBe("PROXY_BACKTEST_NOT_ALLOWED")
  })

  test("rejects asset_class option with an equity proxy symbol", () => {
    const result = validateAssetClassConsistency("SPY", "option")
    expect(result.ok).toBe(false)
    expect(result.code).toBe("OPTIONS_WITH_EQUITY_PROXY_SYMBOL")
  })
})
