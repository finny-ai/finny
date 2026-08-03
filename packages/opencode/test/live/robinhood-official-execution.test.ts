import { describe, expect, test } from "bun:test"
import { McpRobinhood } from "@/mcp/robinhood"
import { RobinhoodExecution } from "@/live/robinhood-execution"
import { RobinhoodBridge } from "@/live/robinhood-bridge"
import { LiveRunner } from "@/live/runner"

const algorithm = {
  algorithmId: "algo",
  userId: "user",
  name: "Algo",
  code: "class Strategy:\n    pass\n",
  language: "python",
  version: 1,
  status: "draft",
  time_created: 1,
  time_updated: 1,
}

function fixture() {
  const definitions = McpRobinhood.EXECUTION_TOOLS.map((name) => ({
    name,
    inputSchema: { type: "object", title: name, additionalProperties: false },
  }))
  const fingerprints = Object.fromEntries(
    definitions.map((definition) => [definition.name, McpRobinhood.schemaFingerprint(definition.inputSchema)]),
  ) as Record<McpRobinhood.ExecutionTool, string>
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let placeFailure = false
  const access: McpRobinhood.BrokerAccess = {
    definitions,
    async callTool(name, args) {
      calls.push({ name, args })
      if (name === "get_accounts") {
        return [{ id: "agentic-1", label: "Agentic", agentic: true, fractionalEquities: true }]
      }
      if (name === "get_portfolio") return { cash: 5000, equity: 6000, observedAt: "2026-08-03T12:00:00Z" }
      if (name === "get_equity_positions") return { AAPL: { qty: 2, mark: 200 } }
      if (name === "get_equity_quotes") return { price: 201, observedAt: "2026-08-03T12:00:00Z" }
      if (name === "get_equity_historicals") {
        return [
          {
            barStart: "2026-08-03T11:59:00Z",
            barEnd: "2026-08-03T12:00:00Z",
            sourceTimestamp: "2026-08-03T12:00:01Z",
            isFinal: true,
            sessionId: "regular-2026-08-03",
            open: 200,
            high: 202,
            low: 199,
            close: 201,
            volume: 1000,
          },
        ]
      }
      if (name === "get_equity_tradability") return { tradable: true, assetType: "equity" }
      if (name === "review_equity_order") return { opaque_review: "do-not-interpret" }
      if (name === "place_equity_order") {
        if (placeFailure) throw new Error("ack lost")
        return { orderId: "order-1", symbol: "AAPL", side: "buy", qty: 1, status: "queued" }
      }
      if (name === "get_equity_orders") {
        return [{ orderId: "order-1", intentId: "a".repeat(64), symbol: "AAPL", side: "buy", qty: 1, status: "queued" }]
      }
      if (name === "cancel_equity_order") {
        return { orderId: "order-1", symbol: "AAPL", side: "buy", qty: 1, status: "cancelled" }
      }
      return {}
    },
  }
  const identity = <T>(value: unknown) => value as T
  const mapping: McpRobinhood.ExecutionSchemaMappingV1 = {
    version: 1,
    fingerprints,
    accounts: { args: () => ({}), result: identity },
    portfolio: { args: ({ accountId }) => ({ accountId }), result: identity },
    positions: { args: ({ accountId }) => ({ accountId }), result: identity },
    quote: { args: (input) => input, result: identity },
    historicals: { args: (input) => input, result: identity },
    tradability: { args: (input) => input, result: identity },
    orders: { args: (input) => input, result: identity },
    review: { args: (input) => ({ ...input }), result: identity },
    place: {
      args: ({ intent, review }) => ({ intent, review }),
      result: identity,
    },
    cancel: { args: (input) => input, result: identity },
  }
  return { access, mapping, calls, failPlace: () => (placeFailure = true) }
}

describe("official Robinhood execution adapter", () => {
  test("reports unsupported paper and disconnected official MCP as explicit preflight checks", async () => {
    const paper = await RobinhoodExecution.preflight(
      { algorithm, runId: "run", symbol: "AAPL", interval: "1min", executionMode: "paper" },
      {},
    )
    expect(paper).toMatchObject({ eligible: false, paperSupported: false })
    expect(paper.checks[0]?.code).toBe("robinhood_paper_unsupported")

    const disconnected = await RobinhoodExecution.preflight(
      { algorithm, runId: "run", symbol: "AAPL", interval: "1min", executionMode: "live" },
      {},
    )
    expect(disconnected.checks.at(-1)?.code).toBe("official_mcp_disconnected")
    expect(disconnected.challengeId).toBeUndefined()
  })

  test("fails closed without authenticated exact schema mapping", () => {
    const { access } = fixture()
    expect(() => McpRobinhood.executionAdapter(access)).toThrow("schemas have not been captured")
  })

  test("requires an explicit Agentic account and never falls back to the first account", async () => {
    const { access, mapping } = fixture()
    const adapter = McpRobinhood.executionAdapter(access, mapping)
    await expect(adapter.agenticAccount("missing")).rejects.toThrow("was not returned")
    await expect(adapter.agenticAccount("agentic-1")).resolves.toMatchObject({ agentic: true })
  })

  test("passes opaque review output to place and reconciles ambiguous acknowledgement without retry", async () => {
    const { access, mapping, calls, failPlace } = fixture()
    const adapter = McpRobinhood.executionAdapter(access, mapping)
    failPlace()
    const result = await adapter.reviewAndPlace({
      intentId: "a".repeat(64),
      accountId: "agentic-1",
      symbol: "AAPL",
      side: "buy",
      qty: 1,
    })
    expect(result.orderId).toBe("order-1")
    expect(calls.filter((call) => call.name === "review_equity_order")).toHaveLength(1)
    expect(calls.filter((call) => call.name === "place_equity_order")).toHaveLength(1)
    expect(calls.filter((call) => call.name === "get_equity_orders")).toHaveLength(1)
    expect(calls.find((call) => call.name === "place_equity_order")?.args).toMatchObject({
      review: { opaque_review: "do-not-interpret" },
    })
  })

  test("cancels every open order through the reviewed cancellation mapping", async () => {
    const { access, mapping, calls } = fixture()
    const adapter = McpRobinhood.executionAdapter(access, mapping)
    expect(await adapter.cancelOpenOrders("agentic-1")).toBe(1)
    expect(calls.filter((call) => call.name === "cancel_equity_order")).toHaveLength(1)
  })

  test("loopback bridge forwards only exact intent fields and enforces its body limit", async () => {
    const { access, mapping, calls } = fixture()
    const bridge = RobinhoodBridge.start(McpRobinhood.executionAdapter(access, mapping), "agentic-1")
    try {
      const intent = {
        intentId: "a".repeat(64),
        symbol: "AAPL",
        side: "buy",
        qty: 1,
        upstreamToken: "must-not-cross-boundary",
      }
      const placed = await fetch(`${bridge.url}/order`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intent),
      })
      expect(placed.status).toBe(200)
      const review = calls.find((call) => call.name === "review_equity_order")?.args
      expect(review).toEqual({
        intentId: "a".repeat(64),
        accountId: "agentic-1",
        symbol: "AAPL",
        side: "buy",
        qty: 1,
      })
      expect(JSON.stringify(review)).not.toContain("must-not-cross-boundary")

      const oversized = await fetch(`${bridge.url}/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(33_000) }),
      })
      expect(oversized.status).toBe(413)
    } finally {
      await bridge.close()
    }
  })

  test("loopback bridge sources strategy bars and prices from official MCP tools", async () => {
    const { access, mapping, calls } = fixture()
    const bridge = RobinhoodBridge.start(McpRobinhood.executionAdapter(access, mapping), "agentic-1")
    try {
      const historical = await fetch(`${bridge.url}/historicals`, {
        method: "POST",
        body: JSON.stringify({ symbol: "AAPL", interval: "1min" }),
      })
      expect(await historical.json()).toMatchObject({ close: 201, isFinal: true })
      const quote = await fetch(`${bridge.url}/quote`, {
        method: "POST",
        body: JSON.stringify({ symbol: "AAPL" }),
      })
      expect(await quote.json()).toMatchObject({ price: 201 })
      expect(calls.some((call) => call.name === "get_equity_historicals")).toBe(true)
      expect(calls.some((call) => call.name === "get_equity_quotes")).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  test("keeps legacy non-Robinhood starts compatible while Robinhood remains explicit", () => {
    expect(LiveRunner.resolveExecutionMode("alpaca", undefined)).toBe("shadow")
    expect(LiveRunner.resolveExecutionMode("alpaca", undefined, true)).toBe("paper")
    expect(() => LiveRunner.resolveExecutionMode("robinhood", undefined)).toThrow("explicit execution mode")
  })

  test("rejects flatten-on-stop until official liquidation is reviewed", () => {
    expect(RobinhoodExecution.unsupportedRiskCheck({ flattenOnStop: true })).toMatchObject({
      code: "flatten_on_stop_unsupported",
      status: "fail",
    })
    expect(RobinhoodExecution.unsupportedRiskCheck({ flattenOnStop: false })).toBeUndefined()
  })
})
