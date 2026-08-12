import { describe, expect, test } from "bun:test"
import { buildCanonicalMetrics, buildWalkForwardSummary } from "../../src/backtest/lean/metrics"
import { parseLeanResultJson } from "../../src/backtest/lean/lean-result-parse"

describe("LEAN result parsing", () => {
  test("maps orders, order events, and equity series", () => {
    const packet = JSON.stringify({
      orders: {
        "1": {
          orderId: 1,
          symbol: { value: "SPY" },
          type: "Market",
          status: 3,
          quantity: 10,
          price: 100,
          tag: "",
          time: "2026-01-09T15:00:00Z",
        },
        "2": {
          orderId: 2,
          symbol: { value: "SPY" },
          type: "Limit",
          status: 6,
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

  test("parses the real BacktestResultPacket array format with epoch seconds", () => {
    // Real LEAN BacktestResultPacket output: Strategy Equity is a candlestick
    // series whose values are [epochSeconds, open, high, low, close] arrays.
    const packet = JSON.stringify({
      orders: {
        "1": {
          orderId: 1,
          symbol: { value: "SPY" },
          type: "Market",
          status: 3,
          quantity: 100,
          price: 100,
          tag: "",
          time: "2026-01-09T05:00:00Z",
        },
      },
      orderEvents: [
        {
          orderId: 1,
          symbol: { value: "SPY" },
          status: "Filled",
          direction: "Buy",
          fillQuantity: 100,
          fillPrice: 100,
          orderFee: { value: 1 },
          utcTime: "2026-01-09T05:00:00Z",
        },
      ],
      charts: {
        "Strategy Equity": {
          series: {
            Equity: {
              values: [
                [1767934800, 10000, 10000, 10000, 10000],
                [1783540800, 6169.4757, 6170.6515, 6169.4757, 6169.6515],
              ],
            },
          },
        },
      },
    })
    const parsed = parseLeanResultJson({
      text: packet,
      summaryText: JSON.stringify({ statistics: { "End Equity": "6169.65", "Net Profit": "-38.303%" } }),
    })
    expect(parsed.equityCurve).toEqual([
      { timestamp: "2026-01-09T05:00:00.000Z", equity: 10000 },
      { timestamp: "2026-07-08T20:00:00.000Z", equity: 6169.6515 },
    ])
    expect(parsed.fills).toHaveLength(1)
    expect(parsed.fills[0]!.fee).toBe(1)
  })
})

describe("walk-forward folds", () => {
  test("uses distinct non-overlapping test windows with an expanding train window", () => {
    const timestamps = Array.from({ length: 60 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 0, 1, 14, 30) + i * 86_400_000)
      return date.toISOString()
    })
    const curve = timestamps.map((timestamp, i) => ({ timestamp, equity: 10000 + i }))
    const summary = buildWalkForwardSummary({
      equityCurve: curve,
      fills: [],
      timestamps,
      warmupBars: 4,
      folds: 3,
    })
    expect(summary.folds).toHaveLength(3)
    const testWindows = summary.folds.map((f) => `${f.test_start}->${f.test_end}`)
    expect(new Set(testWindows).size).toBe(3)
    const trainEnds = summary.folds.map((f) => f.train_end)
    const testStarts = summary.folds.map((f) => f.test_start)
    for (let i = 0; i < summary.folds.length; i++) {
      expect(Date.parse(trainEnds[i]!)).toBeLessThan(Date.parse(testStarts[i]!))
    }
    expect(Date.parse(summary.folds[0]!.test_start)).toBeGreaterThan(Date.parse(summary.folds[0]!.train_end))
    expect(Date.parse(summary.folds[1]!.test_start)).toBeGreaterThan(Date.parse(summary.folds[1]!.train_end))
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

  test("tracks the deepest drawdown on a declining curve", () => {
    const curve = [
      { timestamp: "2026-01-01T00:00:00Z", equity: 10000 },
      { timestamp: "2026-01-02T00:00:00Z", equity: 10000 },
      { timestamp: "2026-01-03T00:00:00Z", equity: 9000 },
      { timestamp: "2026-01-04T00:00:00Z", equity: 9500 },
      { timestamp: "2026-01-05T00:00:00Z", equity: 8000 },
      { timestamp: "2026-01-06T00:00:00Z", equity: 10500 },
    ]
    const v2 = buildCanonicalMetrics({
      equityCurve: curve,
      fills: [],
      orders: [],
      rejections: [],
      startingEquity: 10000,
      seed: 42,
      interval: "1d",
      startTs: "2026-01-01T00:00:00Z",
      endTs: "2026-01-06T23:59:59Z",
      symbols: ["SPY"],
      ohlcvRows: 6,
      engineVersion: "lean-test",
    })
    expect(v2.drawdown.max_drawdown).toBeCloseTo(-0.2, 10)
    expect(v2.drawdown.max_dd_duration_bars).toBe(3)
    expect(v2.drawdown.max_dd_recovery_bars).toBe(1)
    expect(v2.drawdown.current_drawdown).toBe(0)
  })

  test("matches position flips without dropping the excess quantity", () => {
    const curve = Array.from({ length: 9 }, (_, i) => ({
      timestamp: `2026-01-0${i + 1}T00:00:00Z`,
      equity: 10000,
    }))
    // Long 10, then sell 25: 10 close the long, 15 open a short. A later buy
    // of 15 must close that short — not mispair as a new long.
    const fills = [
      { orderId: "1", symbol: "SPY", direction: "Buy", quantity: 10, price: 100, fee: 0.5, time: "2026-01-02T00:00:00Z", status: "Filled" },
      { orderId: "2", symbol: "SPY", direction: "Sell", quantity: 25, price: 102, fee: 1.25, time: "2026-01-04T00:00:00Z", status: "Filled" },
      { orderId: "3", symbol: "SPY", direction: "Buy", quantity: 15, price: 101, fee: 0.75, time: "2026-01-06T00:00:00Z", status: "Filled" },
    ]
    const v2 = buildCanonicalMetrics({
      equityCurve: curve,
      fills,
      orders: [],
      rejections: [],
      startingEquity: 10000,
      seed: 42,
      interval: "1d",
      startTs: "2026-01-01T00:00:00Z",
      endTs: "2026-01-09T00:00:00Z",
      symbols: ["SPY"],
      ohlcvRows: 9,
      engineVersion: "lean-test",
    })
    expect(v2.total_trades).toBe(2)
    expect(v2.trades[0]!.side).toBe("long")
    expect(v2.trades[0]!.qty).toBe(10)
    expect(v2.trades[0]!.pnl).toBeCloseTo(20, 10)
    expect(v2.trades[1]!.side).toBe("short")
    expect(v2.trades[1]!.qty).toBe(15)
    // Short entered at 102, covered at 101: profit on the short = 15 * 1.
    expect(v2.trades[1]!.pnl).toBeCloseTo(15, 10)
  })

  test("derives hold bars, time in market, and exposure from fills and the curve", () => {
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
      interval: "1d",
      startTs: "2026-01-01T00:00:00Z",
      endTs: "2026-01-21T00:00:00Z",
      symbols: ["SPY"],
      ohlcvRows: 21,
      engineVersion: "lean-test",
    })
    // Position is open on bars 01-03 and 01-04 (2 of 21 bars).
    expect(v2.exposure.time_in_market_pct).toBeCloseTo(2 / 21, 10)
    expect(v2.exposure.max_gross_exposure).toBeCloseTo(1000, 10)
    expect(v2.exposure.avg_gross_exposure).toBeCloseTo(2000 / 21, 10)
    // Turnover is a fraction of starting equity, matching engine_v2.
    expect(v2.exposure.total_turnover).toBeCloseTo(2020 / 10000, 10)
    expect(v2.trade.avg_hold_bars).toBe(2)
    expect(v2.trade.longest_trade_bars).toBe(2)
  })
})
