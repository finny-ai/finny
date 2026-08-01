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
    const hostname = new URL(serverUrl).hostname.toLowerCase()
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
  } catch {
    return false
  }
}

type ClientInput = {
  url: string
  fetch: typeof fetch
  headers?: RequestInit["headers"]
}

function responseMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback
  const body = value as Record<string, unknown>
  if (typeof body.message === "string" && body.message) return body.message
  if (typeof body.error === "string" && body.error) return body.error
  if (body.error && typeof body.error === "object") {
    const error = body.error as Record<string, unknown>
    if (typeof error.message === "string" && error.message) return error.message
  }
  return fallback
}

const optionalStatusFields = ["source", "executablePath", "profile", "loginArgs", "message", "checkedAt"] as const

function normalizeStatus(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const status = { ...value }
  // Effect HttpApi encodes optional schema fields as JSON null. Keep the TUI's
  // domain model ergonomic by normalizing that wire representation back to an
  // absent optional value before validating the rest of the payload.
  for (const field of optionalStatusFields) {
    if (Reflect.get(status, field) === null) Reflect.deleteProperty(status, field)
  }
  return status
}

function isStatus(value: unknown): value is RobinhoodIntegrationStatus {
  if (!value || typeof value !== "object") return false
  const status = value as Partial<RobinhoodIntegrationStatus>
  const integrationStates = new Set<RobinhoodIntegrationState>([
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
  const connectionStates = new Set<RobinhoodConnectionState>([
    "unknown",
    "not_configured",
    "configured",
    "ready",
    "mfa_required",
    "expired",
    "error",
  ])
  const connection = (item: unknown): item is RobinhoodConnectionStatus => {
    if (!item || typeof item !== "object") return false
    const candidate = item as Partial<RobinhoodConnectionStatus>
    return (
      typeof candidate.configured === "boolean" &&
      typeof candidate.ready === "boolean" &&
      typeof candidate.state === "string" &&
      connectionStates.has(candidate.state as RobinhoodConnectionState)
    )
  }
  return (
    status.provider === "robinhood" &&
    status.package === "rhx" &&
    typeof status.status === "string" &&
    integrationStates.has(status.status as RobinhoodIntegrationState) &&
    typeof status.pinnedVersion === "string" &&
    typeof status.supported === "boolean" &&
    typeof status.installed === "boolean" &&
    typeof status.ready === "boolean" &&
    (status.source === undefined || status.source === "managed" || status.source === "manual") &&
    (status.executablePath === undefined || typeof status.executablePath === "string") &&
    (status.profile === undefined || typeof status.profile === "string") &&
    (status.loginArgs === undefined ||
      (Array.isArray(status.loginArgs) && status.loginArgs.every((item) => typeof item === "string"))) &&
    (status.message === undefined || typeof status.message === "string") &&
    (status.checkedAt === undefined || typeof status.checkedAt === "string") &&
    connection(status.brokerage) &&
    connection(status.crypto)
  )
}

export function createRobinhoodIntegrationClient(input: ClientInput) {
  async function request(method: "GET" | "POST" | "DELETE", suffix = "", body?: RobinhoodIntegrationOptions) {
    const url = new URL(ROBINHOOD_INTEGRATION_PATH + suffix, input.url)
    const headers = new Headers(input.headers)
    headers.set("accept", "application/json")
    if (body) headers.set("content-type", "application/json")

    const response = await input.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      throw new Error(responseMessage(payload, text || `${method} ${url.pathname} failed (${response.status})`))
    }
    const status = normalizeStatus(payload)
    if (!isStatus(status)) {
      throw new Error(`Unexpected response from ${method} ${url.pathname}`)
    }
    return status
  }

  return {
    status: () => request("GET"),
    install: (options: RobinhoodIntegrationOptions = {}) => request("POST", "/install", options),
    verify: (options: RobinhoodIntegrationOptions = {}) => request("POST", "/verify", options),
    disconnect: () => request("DELETE"),
  }
}
