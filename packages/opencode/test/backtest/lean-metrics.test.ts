import { describe, expect, test } from "bun:test"
import { buildCanonicalMetrics } from "../../src/backtest/lean/metrics"
import { parseLeanResultJson } from "../../src/backtest/lean/lean-result-parse"

describe("LEAN result parsing", () => {
  test("maps orders, order events, and equity series", () => {
    const packet = JSON.stringify({
      orders: {
        "1": {
          orderId: 1,
          symbol: { value: "SPY" },
          type: "Market",
          status: "Filled",
          quantity: 10,
          price: 100,
          tag: "",
          time: "2026-01-09T15:00:00Z",
        },
        "2": {
          orderId: 2,
          symbol: { value: "SPY" },
          type: "Limit",
          status: "Invalid",
          quantity: 5,
          price: 90,
          tag: "",
          time: "2026-01-09T15:05:00Z",
        },
      },
      orderEvents: [
        {
          orderId: 1,
          symbol: { value: "SPY" },
          status: "Filled",
          direction: "Buy",
          fillQuantity: 10,
          fillPrice: 100,
          orderFee: { value: 0.5 },
          time: "2026-01-09T15:00:00Z",
        },
      ],
      charts: {
        Equity: {
          series: {
            Equity: {
              values: [
                { x: 1736438400000, y: 10000 },
                { x: 1736442000000, y: 10100 },
              ],
            },
          },
        },
      },
    })
    const parsed = parseLeanResultJson({ text: packet, summaryText: JSON.stringify({ statistics: { "Total Orders": "1" } }) })
    expect(parsed.orders).toHaveLength(1)
    expect(parsed.rejections).toHaveLength(1)
    expect(parsed.fills).toHaveLength(1)
    expect(parsed.fills[0]!.price).toBe(100)
    expect(parsed.equityCurve).toHaveLength(2)
  })
})

describe("canonical metrics", () => {
  test("computes honest metric blocks from equity and fills", () => {
    const curve = Array.from({ length: 21 }, (_, i) => ({
      timestamp: `2026-01-${String(1 + i).padStart(2, "0")}T00:00:00Z`,
      equity: 10000 * (1 + i * 0.001),
    }))
    const fills = [
      { orderId: "1", symbol: "SPY", direction: "Buy", quantity: 10, price: 100, fee: 0.5, time: "2026-01-03T00:00:00Z", status: "Filled" },
      { orderId: "2", symbol: "SPY", direction: "Sell", quantity: 10, price: 102, fee: 0.5, time: "2026-01-05T00:00:00Z", status: "Filled" },
    ]
    const v2 = buildCanonicalMetrics({
      equityCurve: curve,
      fills,
      orders: [],
      rejections: [],
      startingEquity: 10000,
      seed: 42,
      interval: "5m",
      startTs: "2026-01-01T00:00:00Z",
      endTs: "2026-01-21T00:00:00Z",
      symbols: ["SPY"],
      ohlcvRows: 100,
      engineVersion: "lean-test",
    })
    expect(v2.total_return).toBeCloseTo(curve.at(-1)!.equity / 10000 - 1, 10)
    expect(v2.total_trades).toBe(1)
    expect(v2.trades[0]!.pnl).toBeCloseTo(20, 10)
    expect(v2.trades[0]!.fees).toBeCloseTo(1, 10)
    expect(v2.run_kind).toBe("crucible_2_0")
    expect(v2.data_quality.n_bars).toBe(100)
    expect(v2.drawdown.max_drawdown).toBe(0)
  })
})
