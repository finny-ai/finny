import { expect, test } from "bun:test"
import {
  committedRobinhoodSymbol,
  createRobinhoodLiveClient,
  parseRobinhoodLivePreflight,
  robinhoodAgenticAccountLabel,
  robinhoodLiveBlocker,
  robinhoodTradeLiveAvailability,
} from "./robinhood-live"

const eligible = {
  schema: "finny.robinhood_live_preflight" as const,
  version: 1 as const,
  eligible: true,
  executionMode: "live" as const,
  brokerKind: "robinhood" as const,
  paperSupported: false as const,
  checks: [{ code: "agentic_account", status: "pass" as const, message: "Dedicated Agentic account verified" }],
  account: {
    accountProviderID: "robinhood-agentic-123",
    label: "Agentic",
    accountRole: "agentic" as const,
    accountScopeHash: "scope",
    cash: 900,
    equity: 1000,
    observedAt: "2026-08-03T12:00:00.000Z",
    fractionalEquities: true,
  },
  positions: [{ symbol: "MSFT", qty: 1, mark: 100, marketValue: 100 }],
  openOrders: [{ orderId: "order-1", symbol: "AAPL", side: "buy" as const, qty: 1, status: "open" }],
  risk: {
    maxPositions: 2,
    drawdownLimitPct: 5,
    sizingStopDistancePct: 2,
    protectiveStopMode: "strategy_next_open",
  },
  challengeId: "challenge-1",
  expiresAt: "2026-08-03T12:05:00.000Z",
}

test("parses the exact Robinhood live challenge contract", () => {
  expect(parseRobinhoodLivePreflight(eligible)).toEqual(eligible)
  expect(robinhoodLiveBlocker(parseRobinhoodLivePreflight(eligible))).toBeUndefined()
})

test("fails closed on malformed or ineligible Robinhood preflight", () => {
  expect(() =>
    parseRobinhoodLivePreflight({ ...eligible, account: { ...eligible.account, accountRole: "default" } }),
  ).toThrow("Unexpected Robinhood live preflight response")
  expect(
    robinhoodLiveBlocker({
      ...eligible,
      eligible: false,
      checks: [
        { code: "official_tool_schema_unavailable", status: "fail", message: "Verified tool schema unavailable" },
      ],
      account: undefined,
      challengeId: undefined,
      expiresAt: undefined,
    }),
  ).toBe("Verified tool schema unavailable")
})

test("preflight discovery omits accountProviderID and preserves headers", async () => {
  let sent: { url?: string; method?: string; body?: unknown; auth?: string; directory?: string } = {}
  const client = createRobinhoodLiveClient({
    url: "http://localhost:4096",
    headers: { authorization: "Bearer local" },
    directory: "/tmp/finny workspace",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      sent = {
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization") ?? undefined,
        directory: new Headers(init?.headers).get("x-opencode-directory") ?? undefined,
      }
      return new Response(JSON.stringify(eligible), { status: 200 })
    }) as typeof fetch,
  })

  await expect(
    client.preflight({
      algorithmId: "algo-1",
      runId: "run-1",
      symbol: "AAPL",
      interval: "1min",
      executionMode: "live",
    }),
  ).resolves.toEqual(eligible)
  expect(sent).toEqual({
    url: "http://localhost:4096/live/robinhood/preflight",
    method: "POST",
    body: { algorithmId: "algo-1", runId: "run-1", symbol: "AAPL", interval: "1min", executionMode: "live" },
    auth: "Bearer local",
    directory: "/tmp/finny workspace",
  })
})

test("an immediate symbol edit becomes the exact preflight, confirmation, and start-bound symbol", () => {
  expect(committedRobinhoodSymbol("  msft  ", "AAPL")).toBe("MSFT")
  expect(committedRobinhoodSymbol("", "aapl")).toBe("AAPL")
})

test("Agentic account presentation never falls back to the raw provider ID", () => {
  expect(robinhoodAgenticAccountLabel(eligible.account)).toBe("Agentic")
  expect(
    robinhoodAgenticAccountLabel({
      ...eligible.account,
      label: undefined,
      accountProviderID: "sensitive-provider-account-id",
    }),
  ).toBe("Agentic account")
})

test("connected analysis keeps Trade Live visibly pending until execution schemas are compatible", () => {
  expect(
    robinhoodTradeLiveAvailability({
      connected: true,
      hasStrictRun: true,
      preflight: {
        ...eligible,
        eligible: false,
        account: undefined,
        challengeId: undefined,
        expiresAt: undefined,
        checks: [
          {
            code: "official_tool_schema_unavailable",
            status: "fail",
            message: "Authenticated execution schema mapping is unavailable.",
          },
        ],
      },
    }),
  ).toEqual({
    available: false,
    state: "pending",
    description: "Unavailable · execution compatibility pending",
  })
})

test("Trade Live becomes available only after an eligible executable preflight", () => {
  expect(robinhoodTradeLiveAvailability({ connected: false, hasStrictRun: true })).toMatchObject({ available: false })
  expect(robinhoodTradeLiveAvailability({ connected: true, hasStrictRun: false })).toMatchObject({ available: false })
  expect(robinhoodTradeLiveAvailability({ connected: true, hasStrictRun: true, preflight: eligible })).toEqual({
    available: true,
    state: "available",
    description: "Compatible dedicated Agentic account",
  })
})
