import { describe, expect, test } from "bun:test"
import { zeroTradeLikelyCause } from "../../src/tool/backtest-run"

describe("zero-trade likely-cause diagnosis", () => {
  test("diagnoses margin rejection across mixed buy AND sell attempts", () => {
    // The BTC session shape: 4 buys + 3 sells, all 7 rejected for
    // insufficient_margin. The old logic only matched rejected === buyAttempts
    // and printed nothing here.
    const lines = zeroTradeLikelyCause({
      buyAttempts: 4,
      sellAttempts: 3,
      rejectedOrders: 7,
      rejectionReasons: { insufficient_margin: 7 },
      strategyErrors: 0,
    })
    const text = lines.join("\n")
    expect(text).toContain("Every order (4 buys, 3 sells) was rejected")
    expect(text).toContain("max(1, int(qty))")
    expect(text).toContain("fractional qty")
  })

  test("falls back to a generic line for non-margin rejections", () => {
    const lines = zeroTradeLikelyCause({
      buyAttempts: 2,
      sellAttempts: 0,
      rejectedOrders: 2,
      rejectionReasons: { participation_cap: 2 },
      strategyErrors: 0,
    })
    expect(lines.join("\n")).toContain("All 2 orders were rejected (participation_cap)")
  })

  test("keeps the entry-conditions diagnosis when nothing was attempted", () => {
    const lines = zeroTradeLikelyCause({
      buyAttempts: 0,
      sellAttempts: 0,
      rejectedOrders: 0,
      rejectionReasons: {},
      strategyErrors: 0,
    })
    expect(lines.join("\n")).toContain("Entry conditions never triggered")
  })

  test("keeps the strategy-errors diagnosis", () => {
    const lines = zeroTradeLikelyCause({
      buyAttempts: 1,
      sellAttempts: 0,
      rejectedOrders: 0,
      rejectionReasons: {},
      strategyErrors: 5,
    })
    expect(lines.join("\n")).toContain("raised 5 exceptions")
  })
})
