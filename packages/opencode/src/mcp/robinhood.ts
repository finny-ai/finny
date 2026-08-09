import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import crypto from "node:crypto"
import { stableStringify } from "@/backtest/run-integrity-core"

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
  "get_equity_historicals",
  "search",
  "get_popular_watchlists",
  "get_watchlists",
] as const

export const EXECUTION_TOOLS = [
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_quotes",
  "get_equity_historicals",
  "get_equity_orders",
  "get_equity_tradability",
  "review_equity_order",
  "place_equity_order",
  "cancel_equity_order",
] as const

export type ExecutionTool = (typeof EXECUTION_TOOLS)[number]

export interface ToolDefinition {
  readonly name: string
  readonly inputSchema: unknown
}

export interface AgenticAccount {
  readonly id: string
  readonly label?: string
  /** Must come from an explicit field in the authenticated MCP response. */
  readonly agentic: boolean
  readonly fractionalEquities: boolean
}

export interface AccountSnapshot {
  readonly observedAt: string
  readonly cash: number
  readonly equity: number
  readonly positions: Readonly<Record<string, { readonly qty: number; readonly mark: number }>>
}

export interface HistoricalBar {
  readonly barStart: string
  readonly barEnd: string
  readonly sourceTimestamp: string
  readonly isFinal: true
  readonly sessionId: string
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface EquityOrderIntent {
  readonly intentId: string
  readonly accountId: string
  readonly symbol: string
  readonly side: "buy" | "sell"
  readonly qty: number
}

export interface EquityOrderResult {
  readonly orderId: string
  readonly intentId?: string
  readonly symbol: string
  readonly side: "buy" | "sell"
  readonly qty: number
  readonly status: string
}

type ToolContract<Args, Result> = {
  readonly args: (input: Args) => Record<string, unknown>
  readonly result: (output: unknown) => Result
}

/**
 * Authenticated tools/list capture must supply this mapping. Fingerprints bind
 * every parser and argument builder to the exact official input schema it was
 * reviewed against; there is intentionally no guessed production default.
 */
export interface ExecutionSchemaMappingV1 {
  readonly version: 1
  readonly fingerprints: Readonly<Record<ExecutionTool, string>>
  readonly accounts: ToolContract<void, readonly AgenticAccount[]>
  readonly portfolio: ToolContract<{ accountId: string }, { cash: number; equity: number; observedAt: string }>
  readonly positions: ToolContract<
    { accountId: string },
    Readonly<Record<string, { readonly qty: number; readonly mark: number }>>
  >
  readonly quote: ToolContract<{ accountId: string; symbol: string }, { price: number; observedAt: string }>
  readonly historicals: ToolContract<{ accountId: string; symbol: string; interval: string }, readonly HistoricalBar[]>
  readonly tradability: ToolContract<{ accountId: string; symbol: string }, { tradable: boolean; assetType: string }>
  readonly orders: ToolContract<{ accountId: string; intentId?: string }, readonly EquityOrderResult[]>
  /** Review output is intentionally opaque; the authenticated schema mapping owns its shape. */
  readonly review: ToolContract<EquityOrderIntent, unknown>
  readonly place: ToolContract<{ intent: EquityOrderIntent; review: unknown }, EquityOrderResult>
  readonly cancel: ToolContract<{ accountId: string; order: EquityOrderResult }, EquityOrderResult>
}

export interface BrokerAccess {
  readonly definitions: readonly ToolDefinition[]
  readonly callTool: (name: ExecutionTool, args: Record<string, unknown>) => Promise<unknown>
}

export class OfficialSchemaUnavailableError extends Error {
  constructor(message = "Authenticated Robinhood Trading MCP tool schemas have not been captured and approved.") {
    super(message)
    this.name = "RobinhoodOfficialSchemaUnavailableError"
  }
}

export function schemaFingerprint(schema: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(schema)).digest("hex")
}

function finiteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Robinhood ${label} is invalid.`)
}

function assertMapping(
  definitions: readonly ToolDefinition[],
  mapping: ExecutionSchemaMappingV1 | undefined,
): asserts mapping is ExecutionSchemaMappingV1 {
  if (!mapping) throw new OfficialSchemaUnavailableError()
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  for (const name of EXECUTION_TOOLS) {
    const definition = byName.get(name)
    if (!definition) throw new OfficialSchemaUnavailableError(`Robinhood Trading MCP is missing required tool ${name}.`)
    if (schemaFingerprint(definition.inputSchema) !== mapping.fingerprints[name]) {
      throw new OfficialSchemaUnavailableError(
        `Robinhood Trading MCP schema changed for ${name}; execution remains disabled.`,
      )
    }
  }
}

/** Trusted daemon adapter. It is never exposed through model MCP tools. */
export function executionAdapter(access: BrokerAccess, mapping?: ExecutionSchemaMappingV1) {
  assertMapping(access.definitions, mapping)
  const schema = mapping
  const invoke = <Args, Result>(name: ExecutionTool, contract: ToolContract<Args, Result>, args: Args) =>
    access.callTool(name, contract.args(args)).then(contract.result)

  return {
    async accounts() {
      return await invoke("get_accounts", schema.accounts, undefined)
    },
    async agenticAccount(accountId: string) {
      const accounts = await this.accounts()
      const account = accounts.find((candidate) => candidate.id === accountId)
      if (!account) throw new Error(`Robinhood account ${accountId} was not returned by the official Trading MCP.`)
      if (!account.agentic) throw new Error("Robinhood live execution requires the dedicated Agentic account.")
      return account
    },
    async tradability(accountId: string, symbol: string) {
      const result = await invoke("get_equity_tradability", schema.tradability, { accountId, symbol })
      if (result.assetType.toLowerCase() !== "equity" && result.assetType.toLowerCase() !== "etf") {
        throw new Error("Robinhood v1 execution supports US equities and ETFs only.")
      }
      return result
    },
    async snapshot(accountId: string): Promise<AccountSnapshot> {
      const [portfolio, positions] = await Promise.all([
        invoke("get_portfolio", schema.portfolio, { accountId }),
        invoke("get_equity_positions", schema.positions, { accountId }),
      ])
      finiteNonNegative(portfolio.cash, "cash")
      finiteNonNegative(portfolio.equity, "equity")
      if (!Number.isFinite(Date.parse(portfolio.observedAt)))
        throw new Error("Robinhood account snapshot timestamp is invalid.")
      for (const [symbol, position] of Object.entries(positions)) {
        finiteNonNegative(position.qty, `${symbol} position quantity`)
        finiteNonNegative(position.mark, `${symbol} position mark`)
      }
      return { ...portfolio, positions }
    },
    async quote(accountId: string, symbol: string) {
      const quote = await invoke("get_equity_quotes", schema.quote, { accountId, symbol })
      if (!Number.isFinite(quote.price) || quote.price <= 0) throw new Error("Robinhood quote price is invalid.")
      if (!Number.isFinite(Date.parse(quote.observedAt))) throw new Error("Robinhood quote timestamp is invalid.")
      return quote
    },
    async historicalBars(accountId: string, symbol: string, interval: string) {
      const supported = new Set(["1min", "5min", "15min", "30min", "1h", "4h", "1d"])
      if (!supported.has(interval)) throw new Error("Robinhood historical interval is unsupported.")
      const bars = await invoke("get_equity_historicals", schema.historicals, { accountId, symbol, interval })
      for (const bar of bars) {
        for (const [name, value] of Object.entries({
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        })) {
          if (!Number.isFinite(value) || value < 0 || (name !== "volume" && value <= 0)) {
            throw new Error(`Robinhood historical ${name} is invalid.`)
          }
        }
        if (
          !Number.isFinite(Date.parse(bar.barStart)) ||
          !Number.isFinite(Date.parse(bar.barEnd)) ||
          !Number.isFinite(Date.parse(bar.sourceTimestamp)) ||
          bar.isFinal !== true ||
          !bar.sessionId
        ) {
          throw new Error("Robinhood historical bar metadata is invalid or non-final.")
        }
        if (Date.parse(bar.barEnd) <= Date.parse(bar.barStart)) {
          throw new Error("Robinhood historical bar interval is invalid.")
        }
        if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) {
          throw new Error("Robinhood historical OHLC values are inconsistent.")
        }
      }
      return [...bars].sort((left, right) => Date.parse(left.barEnd) - Date.parse(right.barEnd))
    },
    async reviewAndPlace(intent: EquityOrderIntent): Promise<EquityOrderResult> {
      const reviewed = await invoke("review_equity_order", schema.review, intent)
      try {
        return await invoke("place_equity_order", schema.place, { intent, review: reviewed })
      } catch (cause) {
        // A failed acknowledgement is ambiguous. Reconcile exactly once by the
        // deterministic intent id; never retry place_equity_order.
        const matches = await invoke("get_equity_orders", schema.orders, {
          accountId: intent.accountId,
          intentId: intent.intentId,
        }).catch(() => [])
        const exact = matches.filter((order) => order.intentId === intent.intentId)
        if (exact.length === 1) return exact[0]!
        throw new Error("Robinhood order acknowledgement is ambiguous; execution halted pending reconciliation.", {
          cause,
        })
      }
    },
    async orderByIntentId(accountId: string, intentId: string) {
      const matches = await invoke("get_equity_orders", schema.orders, { accountId, intentId })
      const exact = matches.filter((order) => order.intentId === intentId)
      if (exact.length > 1) throw new Error("Robinhood returned multiple orders for one deterministic intent id.")
      return exact[0]
    },
    async openOrders(accountId: string) {
      const orders = await invoke("get_equity_orders", schema.orders, { accountId })
      return orders.filter(
        (order) => !["filled", "cancelled", "canceled", "rejected", "closed"].includes(order.status.toLowerCase()),
      )
    },
    async cancelOpenOrders(accountId: string) {
      const orders = await this.openOrders(accountId)
      for (const order of orders) await invoke("cancel_equity_order", schema.cancel, { accountId, order })
      return orders.length
    },
  }
}

export type ExecutionAdapter = ReturnType<typeof executionAdapter>

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
  readonly access: "analysis_and_trusted_execution"
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
    access: "analysis_and_trusted_execution",
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
    "## Robinhood Trading MCP (official)",
    `- Connection status: ${input.status}`,
    `- Connection source: ${input.source}`,
    `- Credential custody: ${input.credentialCustody}. ${custody}`,
    `- Available data: ${input.data.join(", ")}.`,
    `- Allowed tools: ${input.tools.join(", ")}.`,
    "- Model-facing tools remain an exact analysis allowlist. Trusted daemon execution is separate, schema-pinned, risk-gated, and never exposed as agent tools.",
    "- Never request or expose Robinhood credentials, tokens, proxy authorization, or raw authentication output.",
  ].join("\n")
}

export * as McpRobinhood from "./robinhood"
