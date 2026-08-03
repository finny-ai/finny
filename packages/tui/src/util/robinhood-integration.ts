export const ROBINHOOD_SERVER_NAME = "robinhood"
export const ROBINHOOD_OFFICIAL_MCP_URL = "https://agent.robinhood.com/mcp/trading"
export const ROBINHOOD_MANAGE_COMMAND = "robinhood.manage"

export type McpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type RobinhoodConnection = {
  connected: boolean
  status: McpStatus["status"] | "not_configured"
  message?: string
}

type ClientInput = {
  url: string
  fetch: typeof fetch
  headers?: RequestInit["headers"]
  directory?: string
}

export function robinhoodEndpointUrl(base: string, pathname: string): URL {
  const root = new URL(base)
  const prefix = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`
  root.pathname = `${prefix}${pathname.replace(/^\/+/, "")}`
  return root
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseMcpStatus(value: unknown): McpStatus | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return
  if (value.status === "connected" || value.status === "disabled" || value.status === "needs_auth") {
    return { status: value.status }
  }
  if ((value.status === "failed" || value.status === "needs_client_registration") && typeof value.error === "string") {
    return { status: value.status, error: value.error }
  }
}

export function robinhoodConnection(value: unknown): RobinhoodConnection {
  if (!isRecord(value)) return { connected: false, status: "not_configured" }
  const status = parseMcpStatus(value[ROBINHOOD_SERVER_NAME])
  if (!status) return { connected: false, status: "not_configured" }
  if (status.status === "connected") return { connected: true, status: "connected" }
  return {
    connected: false,
    status: status.status,
    message: "error" in status ? status.error : undefined,
  }
}

function responseMessage(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback
  if (typeof value.message === "string" && value.message) return value.message
  if (typeof value.error === "string" && value.error) return value.error
  return fallback
}

function requestHeaders(input: ClientInput, json = false) {
  const headers = new Headers(input.headers)
  headers.set("accept", "application/json")
  if (json) headers.set("content-type", "application/json")
  if (input.directory) headers.set("x-opencode-directory", input.directory)
  return headers
}

async function request(input: ClientInput, pathname: string, init: RequestInit = {}) {
  const response = await input.fetch(robinhoodEndpointUrl(input.url, pathname), {
    ...init,
    headers: requestHeaders(input, init.body !== undefined),
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!response.ok) throw new Error(responseMessage(body, text || `${init.method ?? "GET"} ${pathname} failed`))
  return body
}

export function createRobinhoodIntegrationClient(input: ClientInput) {
  const status = async (init: RequestInit = {}) => robinhoodConnection(await request(input, "/mcp", init))

  return {
    status,
    async connect() {
      const added = await request(input, "/mcp", {
        method: "POST",
        body: JSON.stringify({
          name: ROBINHOOD_SERVER_NAME,
          config: { type: "remote", url: ROBINHOOD_OFFICIAL_MCP_URL, enabled: true },
        }),
      })
      const configured = robinhoodConnection(added)
      if (configured.connected) return configured

      const authenticated = parseMcpStatus(
        await request(input, `/mcp/${ROBINHOOD_SERVER_NAME}/auth/authenticate`, { method: "POST" }),
      )
      if (!authenticated) throw new Error("Unexpected response from Robinhood OAuth")
      if (authenticated.status !== "connected") {
        throw new Error("error" in authenticated ? authenticated.error : "Robinhood OAuth did not complete")
      }
      return { connected: true, status: "connected" } satisfies RobinhoodConnection
    },
    async disconnect() {
      await request(input, `/mcp/${ROBINHOOD_SERVER_NAME}/disconnect`, { method: "POST" })
      await request(input, `/mcp/${ROBINHOOD_SERVER_NAME}/auth`, { method: "DELETE" })
      return status()
    },
  }
}
