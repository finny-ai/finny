import { describe, expect, test } from "bun:test"
import { LiveRunner } from "../../src/live/runner"

const run = {
  id: "run-1",
  algorithmId: "algo-1",
  algorithmName: "Mean Reversion",
  symbol: "AAPL",
  interval: "1min",
  brokerKind: "alpaca",
  mode: "paper",
} as any

describe("LiveRunner native hedge event mapping", () => {
  test("maps live-worker messages into ordered native hedge ledger events", () => {
    const events = [
      { type: "init", symbol: "AAPL", interval: "1min", cash: 1000, equity: 1000 },
      { type: "bar", symbol: "AAPL", timestamp: "2026-07-01T12:00:00.000Z", open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
      {
        type: "order_intent",
        symbol: "AAPL",
        side: "buy",
        qty: 2,
        reason: "RSI crossed below 30",
        features: { rsi: 29.4 },
      },
      {
        type: "order",
        order_id: "broker-1",
        symbol: "AAPL",
        side: "buy",
        qty: 2,
        price: 10.1,
        status: "filled",
        reason: "RSI crossed below 30",
      },
      { type: "equity", cash: 979.8, equity: 1001, positions: { AAPL: 2 } },
      { type: "stop", reason: "user_requested" },
    ].flatMap((message) => LiveRunner.nativeEventsForMessageForTests(run, message))

    expect(events.map((event) => event.eventType)).toEqual([
      "run.started",
      "bar.seen",
      "decision.made",
      "order.intent",
      "order.filled",
      "equity.snapshot",
      "position.snapshot",
      "run.stopped",
    ])
    expect(events[2]?.why).toBe("RSI crossed below 30")
    expect(events[3]?.features).toEqual({ rsi: 29.4 })
    expect(events[4]?.orderId).toBe("broker-1")
  })

  test("defaults order why when a strategy does not provide one", () => {
    const [decision, intent] = LiveRunner.nativeEventsForMessageForTests(run, {
      type: "order_intent",
      symbol: "AAPL",
      side: "sell",
      qty: 1,
    })

    expect(decision?.eventType).toBe("decision.made")
    expect(decision?.why).toBe("Strategy submitted order without explicit reason")
    expect(intent?.eventType).toBe("order.intent")
    expect(intent?.why).toBe("Strategy submitted order without explicit reason")
  })

  test("does not mark partial fills as fully filled", () => {
    const [event] = LiveRunner.nativeEventsForMessageForTests(run, {
      type: "order",
      order_id: "broker-2",
      symbol: "AAPL",
      side: "buy",
      qty: 2,
      price: 10.1,
      status: "partially_filled",
    })

    expect(event?.eventType).toBe("order.submitted")
    expect(event?.status).toBe("partially_filled")
  })
})
