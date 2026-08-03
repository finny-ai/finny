export type RobinhoodExecutionMode = "shadow" | "paper" | "live"

export type RobinhoodPreflightCheck = {
  code: string
  status: "pass" | "fail"
  message: string
}

export type RobinhoodLivePreflight = {
  schema: "finny.robinhood_live_preflight"
  version: 1
  eligible: boolean
  executionMode: RobinhoodExecutionMode
  brokerKind: "robinhood"
  paperSupported: false
  checks: RobinhoodPreflightCheck[]
  account?: {
    accountProviderID: string
    label?: string
    accountRole: "agentic"
    accountScopeHash: string
    cash: number
    equity: number
    observedAt: string
    fractionalEquities: boolean
  }
  positions: Array<{ symbol: string; qty: number; mark: number; marketValue: number }>
  openOrders: Array<{
    orderId: string
    intentId?: string
    symbol: string
    side: "buy" | "sell"
    qty: number
    status: string
  }>
  risk?: {
    maxPositions: number
    drawdownLimitPct: number
    sizingStopDistancePct: number
    protectiveStopMode: string
    maxGrossExposurePct?: number
    maxNetExposurePct?: number
    maxSymbolExposurePct?: number
    flattenOnStop?: boolean
  }
  challengeId?: string
  expiresAt?: string
}

export type RobinhoodLivePreflightRequest = {
  algorithmId: string
  runId: string
  symbol: string
  interval: string
  executionMode: RobinhoodExecutionMode
  accountProviderID?: string
}

export function committedRobinhoodSymbol(value: string | undefined, fallback: string): string {
  return (value ?? "").trim().toUpperCase() || fallback.trim().toUpperCase()
}

export function robinhoodAgenticAccountLabel(account: NonNullable<RobinhoodLivePreflight["account"]>): string {
  return account.label?.trim() || "Agentic account"
}

export type RobinhoodTradeLiveAvailability = {
  available: boolean
  state: "available" | "pending" | "unavailable"
  description: string
}

export function robinhoodTradeLiveAvailability(input: {
  connected: boolean
  hasStrictRun: boolean
  preflight?: RobinhoodLivePreflight
  checkFailed?: boolean
}): RobinhoodTradeLiveAvailability {
  if (!input.connected) {
    return { available: false, state: "unavailable", description: "Unavailable · connect Robinhood for analysis first" }
  }
  if (!input.hasStrictRun) {
    return { available: false, state: "unavailable", description: "Unavailable · eligible strict backtest required" }
  }
  if (input.checkFailed) {
    return { available: false, state: "unavailable", description: "Unavailable · execution compatibility check failed" }
  }
  if (!input.preflight) {
    return { available: false, state: "pending", description: "Unavailable · checking execution compatibility" }
  }
  if (input.preflight.eligible && input.preflight.account && input.preflight.challengeId && input.preflight.expiresAt) {
    return { available: true, state: "available", description: "Compatible dedicated Agentic account" }
  }
  const failed = input.preflight.checks.find((check) => check.status === "fail")
  if (failed?.code === "official_tool_schema_unavailable") {
    return { available: false, state: "pending", description: "Unavailable · execution compatibility pending" }
  }
  return {
    available: false,
    state: "unavailable",
    description: `Unavailable · ${failed?.message ?? "live preflight is not eligible"}`,
  }
}

type ClientInput = {
  url: string
  fetch: typeof fetch
  headers?: RequestInit["headers"]
  directory?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function optionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isCheck(value: unknown): value is RobinhoodPreflightCheck {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    (value.status === "pass" || value.status === "fail") &&
    typeof value.message === "string"
  )
}

function isAccount(value: unknown): value is NonNullable<RobinhoodLivePreflight["account"]> {
  return (
    isRecord(value) &&
    typeof value.accountProviderID === "string" &&
    optionalString(value.label) &&
    value.accountRole === "agentic" &&
    typeof value.accountScopeHash === "string" &&
    finite(value.cash) &&
    finite(value.equity) &&
    typeof value.observedAt === "string" &&
    typeof value.fractionalEquities === "boolean"
  )
}

function isPosition(value: unknown): value is RobinhoodLivePreflight["positions"][number] {
  return (
    isRecord(value) &&
    typeof value.symbol === "string" &&
    finite(value.qty) &&
    finite(value.mark) &&
    finite(value.marketValue)
  )
}

function isOpenOrder(value: unknown): value is RobinhoodLivePreflight["openOrders"][number] {
  return (
    isRecord(value) &&
    typeof value.orderId === "string" &&
    optionalString(value.intentId) &&
    typeof value.symbol === "string" &&
    (value.side === "buy" || value.side === "sell") &&
    finite(value.qty) &&
    typeof value.status === "string"
  )
}

function isRisk(value: unknown): value is NonNullable<RobinhoodLivePreflight["risk"]> {
  if (!isRecord(value)) return false
  return (
    finite(value.maxPositions) &&
    finite(value.drawdownLimitPct) &&
    finite(value.sizingStopDistancePct) &&
    typeof value.protectiveStopMode === "string" &&
    (value.maxGrossExposurePct === undefined || finite(value.maxGrossExposurePct)) &&
    (value.maxNetExposurePct === undefined || finite(value.maxNetExposurePct)) &&
    (value.maxSymbolExposurePct === undefined || finite(value.maxSymbolExposurePct)) &&
    (value.flattenOnStop === undefined || typeof value.flattenOnStop === "boolean")
  )
}

export function parseRobinhoodLivePreflight(value: unknown): RobinhoodLivePreflight {
  if (!isRecord(value)) throw new Error("Unexpected Robinhood live preflight response")
  const mode = value.executionMode
  const valid = [
    value.schema === "finny.robinhood_live_preflight",
    value.version === 1,
    typeof value.eligible === "boolean",
    mode === "shadow" || mode === "paper" || mode === "live",
    value.brokerKind === "robinhood",
    value.paperSupported === false,
    Array.isArray(value.checks) && value.checks.every(isCheck),
    value.account === undefined || isAccount(value.account),
    Array.isArray(value.positions) && value.positions.every(isPosition),
    Array.isArray(value.openOrders) && value.openOrders.every(isOpenOrder),
    value.risk === undefined || isRisk(value.risk),
    optionalString(value.challengeId),
    optionalString(value.expiresAt),
  ].every(Boolean)
  if (!valid) throw new Error("Unexpected Robinhood live preflight response")
  return value as RobinhoodLivePreflight
}

function responseMessage(value: unknown, fallback: string) {
  if (!isRecord(value)) return fallback
  if (typeof value.message === "string" && value.message) return value.message
  if (typeof value.error === "string" && value.error) return value.error
  return fallback
}

export function createRobinhoodLiveClient(input: ClientInput) {
  return {
    async preflight(payload: RobinhoodLivePreflightRequest) {
      const headers = new Headers(input.headers)
      headers.set("accept", "application/json")
      headers.set("content-type", "application/json")
      if (input.directory) headers.set("x-opencode-directory", input.directory)
      const response = await input.fetch(new URL("/live/robinhood/preflight", input.url), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
      const text = await response.text()
      let body: unknown
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = undefined
      }
      if (!response.ok)
        throw new Error(responseMessage(body, text || `Robinhood preflight failed (${response.status})`))
      return parseRobinhoodLivePreflight(body)
    },
  }
}

export function robinhoodLiveBlocker(preflight: RobinhoodLivePreflight): string | undefined {
  if (preflight.eligible && preflight.account && preflight.challengeId && preflight.expiresAt) return
  return (
    preflight.checks.find((check) => check.status === "fail")?.message ?? "Robinhood live preflight is not eligible."
  )
}
