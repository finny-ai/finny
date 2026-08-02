import { describe, expect, test } from "bun:test"
import { McpRobinhood } from "@/mcp/robinhood"

describe("Robinhood Trading MCP registration", () => {
  test("registers a secret-free deployment proxy as the canonical remote server", () => {
    const result = McpRobinhood.deployment({
      FINNY_ROBINHOOD_MANAGED: "1",
      FINNY_ROBINHOOD_MCP_URL: "http://127.0.0.1:7777/sessions/session_123/mcp/robinhood",
    })

    expect(result).toEqual({
      managed: true,
      config: {
        type: "remote",
        url: "http://127.0.0.1:7777/sessions/session_123/mcp/robinhood",
        oauth: false,
        enabled: true,
      },
    })
    expect(result.config).not.toHaveProperty("headers")
  })

  test("rejects capability-bearing or credential-bearing URLs without echoing them", () => {
    for (const url of [
      "http://127.0.0.1:7777/mcp?capability=secret-value",
      "http://user:secret-value@127.0.0.1:7777/mcp",
      "http://127.0.0.1:7777/mcp#secret-value",
      "https://proxy.finnyai.tech/mcp",
    ]) {
      const result = McpRobinhood.deployment({
        FINNY_ROBINHOOD_MANAGED: "1",
        FINNY_ROBINHOOD_MCP_URL: url,
      })
      expect(result.config).toBeUndefined()
      expect(result.error).toContain(McpRobinhood.URL_ENV)
      expect(result.error).not.toContain("secret-value")
      expect(result.error).not.toContain(url)
    }
  })

  test("keeps managed custody active when no broker connection is available", () => {
    expect(McpRobinhood.deployment({ FINNY_ROBINHOOD_MANAGED: "1" })).toEqual({ managed: true })
    expect(McpRobinhood.deployment({})).toEqual({ managed: false })

    const urlWithoutMarker = McpRobinhood.deployment({
      FINNY_ROBINHOOD_MCP_URL: "http://127.0.0.1:7777/mcp/opaque",
    })
    expect(urlWithoutMarker).toEqual({
      managed: false,
      error: `${McpRobinhood.URL_ENV} requires ${McpRobinhood.MANAGED_ENV}=1.`,
    })
    expect(urlWithoutMarker.config).toBeUndefined()

    const malformedMarker = McpRobinhood.deployment({ FINNY_ROBINHOOD_MANAGED: "0" })
    expect(malformedMarker).toEqual({
      managed: true,
      error: `${McpRobinhood.MANAGED_ENV} must be 1 when present.`,
    })
  })

  test("recognizes only an explicitly managed loopback broker or the exact official endpoint", () => {
    expect(
      McpRobinhood.isServer("robinhood", {
        type: "remote",
        url: "https://proxy.finnyai.tech/mcp/robinhood",
      }),
    ).toBe(false)
    const managed = {
      type: "remote" as const,
      url: "http://127.0.0.1:7777/sessions/session_123/mcp/robinhood",
      oauth: false,
    }
    expect(McpRobinhood.isServer("robinhood", managed)).toBe(false)
    expect(McpRobinhood.isServer("robinhood", managed, true)).toBe(true)
    expect(
      McpRobinhood.isServer("robinhood", {
        type: "remote",
        url: `${McpRobinhood.OFFICIAL_URL}/`,
      }),
    ).toBe(true)
    expect(
      McpRobinhood.isServer("robinhood", {
        type: "remote",
        url: McpRobinhood.OFFICIAL_URL,
        oauth: { scope: "read" },
      }),
    ).toBe(true)
    expect(
      McpRobinhood.isServer("portfolio", {
        type: "remote",
        url: McpRobinhood.OFFICIAL_URL,
      }),
    ).toBe(false)
    expect(
      McpRobinhood.isOfficialEndpoint({
        type: "remote",
        url: McpRobinhood.OFFICIAL_URL,
      }),
    ).toBe(true)
    expect(
      McpRobinhood.isServer("portfolio", {
        type: "remote",
        url: "https://example.com/mcp",
      }),
    ).toBe(false)
  })

  test("rejects lookalike or capability-bearing official endpoint URLs", () => {
    for (const url of [
      `${McpRobinhood.OFFICIAL_URL}?capability=secret-value`,
      `${McpRobinhood.OFFICIAL_URL}#secret-value`,
      "https://user:secret-value@agent.robinhood.com/mcp/trading",
      "https://agent.robinhood.com/mcp/trading/extra",
      "https://agent.robinhood.com:444/mcp/trading",
    ]) {
      expect(McpRobinhood.isServer("robinhood", { type: "remote", url })).toBe(false)
    }
  })

  test("requires official OAuth custody without caller-supplied headers", () => {
    for (const config of [
      { type: "remote" as const, url: McpRobinhood.OFFICIAL_URL, oauth: false },
      { type: "remote" as const, url: McpRobinhood.OFFICIAL_URL, headers: {} },
      {
        type: "remote" as const,
        url: McpRobinhood.OFFICIAL_URL,
        headers: { Authorization: "Bearer caller-controlled" },
      },
      {
        type: "remote" as const,
        url: McpRobinhood.OFFICIAL_URL,
        oauth: { scope: "read" },
        headers: { "X-Custom": "caller-controlled" },
      },
    ]) {
      expect(McpRobinhood.isServer(McpRobinhood.SERVER_NAME, config)).toBe(false)
      expect(McpRobinhood.isOfficialEndpoint(config)).toBe(true)
    }
  })
})

describe("Robinhood Trading MCP tool policy", () => {
  test("uses the exact official v1 read allowlist", () => {
    expect(McpRobinhood.READ_TOOLS).toEqual([
      "get_accounts",
      "get_portfolio",
      "get_equity_positions",
      "get_equity_quotes",
      "get_equity_orders",
      "get_equity_tradability",
      "search",
      "get_popular_watchlists",
      "get_watchlists",
    ])
  })

  test("omits every known mutation and unknown tool regardless of annotations", () => {
    const tools = [
      ...McpRobinhood.READ_TOOLS.map((name) => ({ name, annotations: { readOnlyHint: false } })),
      { name: "review_equity_order", annotations: { readOnlyHint: true } },
      { name: "place_equity_order", annotations: { readOnlyHint: true } },
      { name: "cancel_equity_order", annotations: { readOnlyHint: true } },
      { name: "create_watchlist", annotations: { readOnlyHint: true } },
      { name: "update_watchlist", annotations: { readOnlyHint: true } },
      { name: "add_to_watchlist", annotations: { readOnlyHint: true } },
      { name: "remove_from_watchlist", annotations: { readOnlyHint: true } },
      { name: "get_option_positions", annotations: { readOnlyHint: true } },
      { name: "future_read_tool", annotations: { readOnlyHint: true } },
    ]

    expect(McpRobinhood.filterTools(tools).map((tool) => tool.name)).toEqual([...McpRobinhood.READ_TOOLS])
  })
})

describe("Robinhood Trading MCP context", () => {
  test("reports safe brokerage metadata without endpoint or authorization material", () => {
    const info = McpRobinhood.metadata({
      managed: true,
      status: "connected",
    })
    const context = McpRobinhood.renderContext(info)

    expect(info).toMatchObject({
      id: "robinhood",
      official: true,
      access: "read_only",
      source: "runner_local_broker",
      credentialCustody: "platform",
      status: "connected",
      assetClasses: ["equity"],
    })
    expect(context).toContain("official, read-only")
    expect(context).toContain("omits every mutation and unknown Robinhood MCP tool")
    expect(context).toContain("maximum 90-second lifespan")
    expect(context).toContain("managed Finny receives no upstream Robinhood or Platform capability tokens")
    expect(context).not.toContain("local OpenCode auth storage")
    expect(context).not.toContain("private-deployment-id")
    expect(context).not.toContain("127.0.0.1")
    expect(context).not.toContain("Authorization")
  })

  test("reports direct local OAuth custody without implying managed Platform custody", () => {
    const info = McpRobinhood.metadata({
      status: "needs_auth",
    })
    const context = McpRobinhood.renderContext(info)

    expect(info).toMatchObject({
      source: "robinhood_oauth",
      credentialCustody: "local_opencode",
      status: "needs_auth",
    })
    expect(context).toContain("direct local connection")
    expect(context).toContain("local OpenCode auth storage")
    expect(context).not.toContain("managed Finny receives no upstream Robinhood or Platform capability tokens")
    expect(context).not.toContain(McpRobinhood.OFFICIAL_URL)
  })
})
