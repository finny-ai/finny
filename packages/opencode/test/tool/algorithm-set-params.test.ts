import { describe, expect, test } from "bun:test"
import { blockedIdentityParamKeys } from "../../src/tool/algorithm-set-params"

describe("finny_algorithm_set_params identity guard", () => {
  test("blocks execution identity fields", () => {
    expect(
      blockedIdentityParamKeys({
        symbol: "BTC/USD",
        asset_class: "crypto",
        interval: "1d",
        required_history_bars: 50,
        brokerage: "binance",
      }),
    ).toEqual(["symbol", "asset_class", "interval", "required_history_bars", "brokerage"])
  })

  test("allows non-identity runtime inputs and strategy params", () => {
    expect(
      blockedIdentityParamKeys({
        equity_usd: 10000,
        backtest: { duration: "3m" },
        params: { rsi_period: 14 },
      }),
    ).toEqual([])
  })
})
