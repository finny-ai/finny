import { expect, test } from "bun:test"
import {
  brokerSelectableForRunMode,
  brokerVisibleForRunMode,
  committedRobinhoodSymbol,
  createRobinhoodLiveClient,
  parseRobinhoodLivePreflight,
  robinhoodAgenticAccountLabel,
  robinhoodLiveBlocker,
  robinhoodPreflightStartBlocker,
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
  ).toThrow("invalid account")
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

test("Robinhood is absent from paper brokerage choices", () => {
  expect(brokerVisibleForRunMode("robinhood", "paper")).toBe(false)
  expect(brokerVisibleForRunMode("robinhood", "live")).toBe(true)
  expect(brokerVisibleForRunMode("alpaca", "paper")).toBe(true)
})

test("Robinhood is selectable only for connected, execution-compatible live runs", () => {
  const input = {
    kind: "robinhood",
    runMode: "live" as const,
    supports: true,
    robinhoodConnected: true,
    robinhoodExecutionCompatible: true,
  }
  expect(brokerSelectableForRunMode(input)).toBe(true)
  expect(brokerSelectableForRunMode({ ...input, runMode: "paper" })).toBe(false)
  expect(brokerSelectableForRunMode({ ...input, robinhoodConnected: false })).toBe(false)
  expect(brokerSelectableForRunMode({ ...input, robinhoodExecutionCompatible: false })).toBe(false)
  expect(brokerSelectableForRunMode({ ...input, supports: false })).toBe(false)
  expect(brokerSelectableForRunMode({ ...input, kind: "alpaca", runMode: "paper" })).toBe(true)
})

test("live confirmation fails closed when its challenge is missing or expired", () => {
  expect(robinhoodPreflightStartBlocker(undefined, 0)).toContain("checked again")
  expect(robinhoodPreflightStartBlocker(eligible, Date.parse(eligible.expiresAt) - 1)).toBeUndefined()
  expect(robinhoodPreflightStartBlocker(eligible, Date.parse(eligible.expiresAt))).toContain("expired")
})

test("optional risk fields are validated independently", () => {
  expect(parseRobinhoodLivePreflight({ ...eligible, risk: { ...eligible.risk, flattenOnStop: true } }).risk).toEqual({
    ...eligible.risk,
    flattenOnStop: true,
  })
  expect(() =>
    parseRobinhoodLivePreflight({ ...eligible, risk: { ...eligible.risk, maxNetExposurePct: "100" } }),
  ).toThrow("invalid risk")
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

test("preflight surfaces non-JSON server errors and applies a default abort signal", async () => {
  let signal: AbortSignal | undefined
  const client = createRobinhoodLiveClient({
    url: "http://localhost:4096/base",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:4096/base/live/robinhood/preflight")
      signal = init?.signal as AbortSignal
      return new Response("gateway unavailable", { status: 502 })
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
  ).rejects.toThrow("gateway unavailable")
  expect(signal).toBeInstanceOf(AbortSignal)
})

test("preflight aborts when its timeout elapses", async () => {
  const client = createRobinhoodLiveClient({
    url: "http://localhost:4096",
    fetch: ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch,
  })
  await expect(
    client.preflight(
      {
        algorithmId: "algo-1",
        runId: "run-1",
        symbol: "AAPL",
        interval: "1min",
        executionMode: "live",
      },
      { timeoutMs: 5 },
    ),
  ).rejects.toThrow("timed out")
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
