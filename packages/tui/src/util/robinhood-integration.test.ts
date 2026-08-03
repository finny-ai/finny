import { expect, test } from "bun:test"
import {
  createRobinhoodIntegrationClient,
  robinhoodEndpointUrl,
  robinhoodConnection,
  ROBINHOOD_OFFICIAL_MCP_URL,
} from "./robinhood-integration"

test("Robinhood endpoints preserve a configured daemon base path", () => {
  expect(robinhoodEndpointUrl("https://finny.test/api/v1", "/mcp").toString()).toBe("https://finny.test/api/v1/mcp")
  expect(robinhoodEndpointUrl("https://finny.test/", "mcp").toString()).toBe("https://finny.test/mcp")
})

test("Robinhood status exposes only Connected or Not connected semantics", () => {
  expect(robinhoodConnection({ robinhood: { status: "connected" } })).toEqual({
    connected: true,
    status: "connected",
  })
  expect(robinhoodConnection({ robinhood: { status: "needs_auth" } })).toEqual({
    connected: false,
    status: "needs_auth",
  })
  expect(robinhoodConnection({})).toEqual({ connected: false, status: "not_configured" })
  expect(robinhoodConnection({ robinhood: { status: "failed", error: "OAuth expired" } })).toEqual({
    connected: false,
    status: "failed",
    message: "OAuth expired",
  })
})

test("Robinhood connect configures the reserved official MCP then starts OAuth", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (url.endsWith("/mcp")) {
      return new Response(JSON.stringify({ robinhood: { status: "needs_auth" } }), { status: 200 })
    }
    return new Response(JSON.stringify({ status: "connected" }), { status: 200 })
  }
  const client = createRobinhoodIntegrationClient({ url: "http://localhost:4096", fetch: mockFetch as typeof fetch })

  await expect(client.connect()).resolves.toEqual({ connected: true, status: "connected" })
  expect(calls).toEqual([
    {
      url: "http://localhost:4096/mcp",
      method: "POST",
      body: {
        name: "robinhood",
        config: { type: "remote", url: ROBINHOOD_OFFICIAL_MCP_URL, enabled: true },
      },
    },
    {
      url: "http://localhost:4096/mcp/robinhood/auth/authenticate",
      method: "POST",
      body: undefined,
    },
  ])
})

test("Robinhood disconnect stops the MCP, removes OAuth, then refreshes status", async () => {
  const calls: string[] = []
  const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`)
    if ((init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ robinhood: { status: "disabled" } }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
  const client = createRobinhoodIntegrationClient({ url: "http://localhost:4096", fetch: mockFetch as typeof fetch })

  await expect(client.disconnect()).resolves.toEqual({ connected: false, status: "disabled" })
  expect(calls).toEqual(["POST /mcp/robinhood/disconnect", "DELETE /mcp/robinhood/auth", "GET /mcp"])
})

test("Robinhood client surfaces lifecycle errors", async () => {
  const client = createRobinhoodIntegrationClient({
    url: "http://localhost:4096",
    fetch: (async () =>
      new Response(JSON.stringify({ error: "Runner-managed Robinhood MCP lifecycle is Platform-owned." }), {
        status: 403,
      })) as unknown as typeof fetch,
  })

  await expect(client.connect()).rejects.toThrow("Runner-managed Robinhood MCP lifecycle is Platform-owned.")
})
