import path from "node:path"

export const ROBINHOOD_INTEGRATION_PATH = "/global/integrations/robinhood"
export const ROBINHOOD_MANAGE_COMMAND = "robinhood.manage"
export const ROBINHOOD_CRYPTO_URL = "https://robinhood.com/account/crypto"

export type RobinhoodIntegrationState =
  | "unsupported"
  | "not_installed"
  | "installing"
  | "installed"
  | "authenticating"
  | "ready"
  | "mfa_required"
  | "expired"
  | "error"

export type RobinhoodConnectionState =
  | "unknown"
  | "not_configured"
  | "configured"
  | "ready"
  | "mfa_required"
  | "expired"
  | "error"

export type RobinhoodConnectionStatus = {
  configured: boolean
  ready: boolean
  state: RobinhoodConnectionState
}

export type RobinhoodIntegrationStatus = {
  provider: "robinhood"
  package: "rhx"
  pinnedVersion: string
  status: RobinhoodIntegrationState
  supported: boolean
  installed: boolean
  ready: boolean
  source?: "managed" | "manual"
  executablePath?: string
  profile?: string
  loginArgs?: string[]
  brokerage: RobinhoodConnectionStatus
  crypto: RobinhoodConnectionStatus
  message?: string
  checkedAt?: string
}

export type RobinhoodIntegrationOptions = {
  executablePath?: string
  profile?: string
}

export function managedRobinhoodLoginCommand(input: {
  packageDirectory: string
  profile: string
  runtimePath?: string
  platform?: NodeJS.Platform
}) {
  const profile = input.profile.trim() || "default"
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(profile)) throw new Error("Enter a valid RHX profile")
  const paths = (input.platform ?? process.platform) === "win32" ? path.win32 : path
  const entrypoint = paths.join(input.packageDirectory, "bin", "rhx.cjs")
  return {
    command: input.runtimePath ?? process.execPath,
    args: [entrypoint, "--profile", profile, "auth", "login"],
    entrypoint,
  }
}

export function canRunRobinhoodLoginLocally(serverUrl: string): boolean {
  try {
    const url = new URL(serverUrl)
    // The default TUI talks to its same-process worker through this synthetic
    // origin. It is local even though it is not represented by a loopback IP.
    if (url.origin === "http://opencode.internal") return true
    const hostname = url.hostname.toLowerCase()
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
  } catch {
    return false
  }
}

export function canSelectRobinhood(status: Pick<RobinhoodIntegrationStatus, "brokerage" | "crypto">): boolean {
  return status.brokerage.ready || status.crypto.ready
}

type ClientInput = {
  url: string
  fetch: typeof fetch
  headers?: RequestInit["headers"]
}

type RequestMethod = "GET" | "POST" | "DELETE"

const integrationStates: ReadonlySet<string> = new Set([
  "unsupported",
  "not_installed",
  "installing",
  "installed",
  "authenticating",
  "ready",
  "mfa_required",
  "expired",
  "error",
])

const connectionStates: ReadonlySet<string> = new Set([
  "unknown",
  "not_configured",
  "configured",
  "ready",
  "mfa_required",
  "expired",
  "error",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function responseMessage(value: unknown, fallback: string) {
  const body = record(value)
  if (!body) return fallback
  const error = record(body.error)
  return nonEmptyString(body.message) ?? nonEmptyString(body.error) ?? nonEmptyString(error?.message) ?? fallback
}

const optionalStatusFields = ["source", "executablePath", "profile", "loginArgs", "message", "checkedAt"] as const

function normalizeStatus(value: unknown): unknown {
  const body = record(value)
  if (!body) return value
  const status = { ...body }
  // Effect HttpApi encodes optional schema fields as JSON null. Keep the TUI's
  // domain model ergonomic by normalizing that wire representation back to an
  // absent optional value before validating the rest of the payload.
  for (const field of optionalStatusFields) {
    if (Reflect.get(status, field) === null) Reflect.deleteProperty(status, field)
  }
  return status
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string"
}

function isOptionalStringArray(value: unknown) {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"))
}

function isConnectionStatus(value: unknown): value is RobinhoodConnectionStatus {
  const candidate = record(value)
  if (!candidate) return false
  return [
    typeof candidate.configured === "boolean",
    typeof candidate.ready === "boolean",
    typeof candidate.state === "string" && connectionStates.has(candidate.state),
  ].every(Boolean)
}

function isStatus(value: unknown): value is RobinhoodIntegrationStatus {
  const status = record(value)
  if (!status) return false
  return [
    status.provider === "robinhood",
    status.package === "rhx",
    typeof status.status === "string" && integrationStates.has(status.status),
    typeof status.pinnedVersion === "string",
    typeof status.supported === "boolean",
    typeof status.installed === "boolean",
    typeof status.ready === "boolean",
    status.source === undefined || status.source === "managed" || status.source === "manual",
    isOptionalString(status.executablePath),
    isOptionalString(status.profile),
    isOptionalStringArray(status.loginArgs),
    isOptionalString(status.message),
    isOptionalString(status.checkedAt),
    isConnectionStatus(status.brokerage),
    isConnectionStatus(status.crypto),
  ].every(Boolean)
}

function parsePayload(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

function requestHeaders(input: ClientInput, body?: RobinhoodIntegrationOptions) {
  const headers = new Headers(input.headers)
  headers.set("accept", "application/json")
  if (body) headers.set("content-type", "application/json")
  return headers
}

async function requestStatus(
  input: ClientInput,
  method: RequestMethod,
  suffix = "",
  body?: RobinhoodIntegrationOptions,
) {
  const url = new URL(ROBINHOOD_INTEGRATION_PATH + suffix, input.url)
  const response = await input.fetch(url, {
    method,
    headers: requestHeaders(input, body),
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const payload = parsePayload(text)

  if (!response.ok) {
    throw new Error(responseMessage(payload, text || `${method} ${url.pathname} failed (${response.status})`))
  }
  const status = normalizeStatus(payload)
  if (!isStatus(status)) throw new Error(`Unexpected response from ${method} ${url.pathname}`)
  return status
}

export function createRobinhoodIntegrationClient(input: ClientInput) {
  const request = (method: RequestMethod, suffix = "", body?: RobinhoodIntegrationOptions) =>
    requestStatus(input, method, suffix, body)

  return {
    status: () => request("GET"),
    install: (options: RobinhoodIntegrationOptions = {}) => request("POST", "/install", options),
    verify: (options: RobinhoodIntegrationOptions = {}) => request("POST", "/verify", options),
    disconnect: () => request("DELETE"),
  }
}
