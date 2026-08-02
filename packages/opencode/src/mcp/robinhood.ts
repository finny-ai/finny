import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"

export const SERVER_NAME = "robinhood"
export const OFFICIAL_URL = "https://agent.robinhood.com/mcp/trading"
export const URL_ENV = "FINNY_ROBINHOOD_MCP_URL"
export const MANAGED_ENV = "FINNY_ROBINHOOD_MANAGED"

export const READ_TOOLS = [
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_quotes",
  "get_equity_orders",
  "get_equity_tradability",
  "search",
  "get_popular_watchlists",
  "get_watchlists",
] as const

export type ReadTool = (typeof READ_TOOLS)[number]
export type Env = Record<string, string | undefined>
export type Remote = ConfigMCPV1.Info & { type: "remote" }

const reads = new Set<string>(READ_TOOLS)
const official = new URL(OFFICIAL_URL)

export type Deployment = {
  readonly managed: boolean
  readonly config?: Remote
  readonly error?: string
}

export type Metadata = {
  readonly id: typeof SERVER_NAME
  readonly name: "Robinhood Trading MCP"
  readonly official: true
  readonly transport: "remote"
  readonly access: "read_only"
  readonly source: "runner_local_broker" | "robinhood_oauth"
  readonly credentialCustody: "platform" | "local_opencode"
  readonly status: string
  readonly assetClasses: readonly ["equity"]
  readonly data: readonly ["accounts", "portfolio", "positions", "quotes", "orders", "watchlists"]
  readonly tools: typeof READ_TOOLS
}

function remoteURL(value: string): URL | undefined {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) return
  if (url.username || url.password || url.search || url.hash) return
  return url
}

function officialURL(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) return false
  return url.origin === official.origin && url.pathname.replace(/\/+$/, "") === official.pathname
}

/**
 * Resolve the runner-local, per-session broker without accepting credentials in
 * the environment. Authorization remains outside Finny's process environment.
 */
export function deployment(env: Env = process.env): Deployment {
  const marker = env[MANAGED_ENV]
  const managed = marker !== undefined
  if (managed && marker?.trim() !== "1") {
    return { managed: true, error: `${MANAGED_ENV} must be 1 when present.` }
  }
  const value = env[URL_ENV]?.trim()
  if (!value) return { managed }
  if (!managed) {
    return { managed: false, error: `${URL_ENV} requires ${MANAGED_ENV}=1.` }
  }
  const url = remoteURL(value)
  if (!url) {
    return {
      managed: true,
      error: `${URL_ENV} must be a loopback HTTP(S) URL without user info, query parameters, or fragments.`,
    }
  }
  return {
    managed: true,
    config: {
      type: "remote",
      url: url.toString(),
      oauth: false,
      enabled: true,
    },
  }
}

export function isServer(name: string, config: unknown, managed = false): config is Remote {
  if (!config || typeof config !== "object" || !("type" in config) || !("url" in config)) return false
  if (config.type !== "remote" || typeof config.url !== "string") return false
  if (name !== SERVER_NAME) return false
  const oauth = "oauth" in config ? config.oauth : undefined
  const headers = "headers" in config ? config.headers : undefined
  if (officialURL(config.url)) return !managed && oauth !== false && headers === undefined
  if (!managed || remoteURL(config.url) === undefined) return false
  if (!("oauth" in config) || oauth !== false) return false
  return headers === undefined
}

export function isOfficialEndpoint(config: unknown): config is Remote {
  if (!config || typeof config !== "object" || !("type" in config) || !("url" in config)) return false
  return config.type === "remote" && typeof config.url === "string" && officialURL(config.url)
}

/** Exact v1 allowlist. MCP annotations never widen this boundary. */
export function isReadTool(name: string): name is ReadTool {
  return reads.has(name)
}

export function filterTools<T extends { readonly name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => isReadTool(tool.name))
}

export function toolID(name: ReadTool): string {
  return `${SERVER_NAME}_${name}`
}

export function isToolID(id: string): boolean {
  return READ_TOOLS.some((name) => toolID(name) === id)
}

export function isServerToolID(id: string): boolean {
  return id.startsWith(`${SERVER_NAME}_`)
}

export function permissionConfig(): Record<string, "ask" | "deny"> {
  return {
    [`${SERVER_NAME}_*`]: "deny",
    ...Object.fromEntries(READ_TOOLS.map((name) => [toolID(name), "ask" as const])),
  }
}

export function metadata(input: { readonly status?: string; readonly managed?: boolean }): Metadata {
  return {
    id: SERVER_NAME,
    name: "Robinhood Trading MCP",
    official: true,
    transport: "remote",
    access: "read_only",
    source: input.managed ? "runner_local_broker" : "robinhood_oauth",
    credentialCustody: input.managed ? "platform" : "local_opencode",
    status: input.status ?? "configured",
    assetClasses: ["equity"],
    data: ["accounts", "portfolio", "positions", "quotes", "orders", "watchlists"],
    tools: READ_TOOLS,
  }
}

export function renderContext(input: Metadata): string {
  const custody =
    input.credentialCustody === "platform"
      ? "Platform holds upstream Robinhood OAuth and renews broker capabilities with a maximum 90-second lifespan server-side; managed Finny receives no upstream Robinhood or Platform capability tokens."
      : "This direct local connection stores Robinhood OAuth in local OpenCode auth storage."
  return [
    "## Robinhood Trading MCP (official, read-only)",
    `- Connection status: ${input.status}`,
    `- Connection source: ${input.source}`,
    `- Credential custody: ${input.credentialCustody}. ${custody}`,
    `- Available data: ${input.data.join(", ")}.`,
    `- Allowed tools: ${input.tools.join(", ")}.`,
    "- Finny v1 omits every mutation and unknown Robinhood MCP tool, regardless of MCP annotations. It cannot place, review, cancel, or modify orders or mutate watchlists through this connection.",
    "- The legacy RHX connector is separate and remains governed by its existing shadow-only broker policy.",
    "- Never request or expose Robinhood credentials, tokens, proxy authorization, or raw authentication output.",
  ].join("\n")
}

export * as McpRobinhood from "./robinhood"
