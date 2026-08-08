/**
 * Worker shell secret boundary.
 *
 * Model-controlled Finny workers (Data/news/SEC/sentiment/research) run bash
 * with a deny-by-default environment. Only keys registered below may reach a
 * worker process. Host LLM keys, plugin secrets, and telemetry secrets never
 * appear unless explicitly allowlisted for that agent/asset class.
 *
 * Adding a new market-data credential for Data Agent:
 * 1. Register the env key in `DATA_PROVIDER_CREDENTIALS` with its asset class.
 * 2. Extend the corresponding engine_v2/data provider to read that key.
 * 3. Add/adjust a unit test in `test/security/worker-shell.test.ts`.
 * 4. Document the key in `docs/security/worker-env-allowlist.md`.
 *
 * Do not broaden the allowlist "just in case" — unknown keys stay denied.
 */
import { regionalMarketForTicker } from "@/data/regional-markets"

export const WORKER_SHELL_POLICY_VERSION = 1 as const

/** Runtime-only keys every Finny worker may need (no provider secrets). */
export const WORKER_RUNTIME_ENV = [
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "VIRTUAL_ENV",
  "FINNY_PYTHON_BIN",
  "FINNY_MANAGED_PYTHON",
  "FINNY_STRATEGY_WORKSPACE_NAME",
  "FINNY_STRATEGY_WORKSPACE_PATH",
  "ALLOWED_DATA_DIR",
  "FINNY_ALLOWED_DATA_DIR",
  // Headless harness fixture plumbing (non-secret). Data Agent bash materializes
  // market evidence via FINNY_HARNESS_MARKET_DATA_URL; do not open all FINNY_*.
  "FINNY_HARNESS_MODE",
  "FINNY_HARNESS_MARKET_DATA_URL",
  "FINNY_HARNESS_MARKET_DATA_CSV",
  "FINNY_HARNESS_MARKET_DATA_SHA256",
  "FINNY_HARNESS_FIXTURE_MARKET_DATA",
  "FINNY_HARNESS_SCRIPTED_MODEL",
] as const

/**
 * Market-data credentials scoped by asset class.
 * Keep this list synchronized with engine_v2/data providers and shell.env
 * injection in `tool/shell.ts` (e.g. resolveAlpacaMarketDataEnv).
 */
export const DATA_PROVIDER_CREDENTIALS = [
  // Equity / ETF market data (Alpaca + optional Polygon/Bloomberg/generic).
  { key: "ALPACA_OAUTH_TOKEN", assets: ["equity"] as const },
  { key: "ALPACA_API_KEY_ID", assets: ["equity"] as const },
  { key: "ALPACA_API_SECRET_KEY", assets: ["equity"] as const },
  { key: "ALPACA_DATA_FEED", assets: ["equity"] as const },
  { key: "POLYGON_API_KEY", assets: ["equity"] as const },
  { key: "MARKET_DATA_API_KEY", assets: ["equity"] as const },
  { key: "BLOOMBERG_API_KEY", assets: ["equity"] as const },
  { key: "ORACLE_MARKET_DATA_URL", assets: ["equity"] as const },
  // Exact-listing regional equity data, injected only for the matching ticker.
  { key: "KITE_API_KEY", assets: ["equity"] as const },
  { key: "KITE_ACCESS_TOKEN", assets: ["equity"] as const },
  { key: "KITE_ENDPOINT", assets: ["equity"] as const },
  { key: "SAXO_ACCOUNT_KEY", assets: ["equity"] as const },
  { key: "SAXO_ACCESS_TOKEN", assets: ["equity"] as const },
  { key: "SAXO_ENDPOINT", assets: ["equity"] as const },
  { key: "QUESTRADE_ACCOUNT_ID", assets: ["equity"] as const },
  { key: "QUESTRADE_ACCESS_TOKEN", assets: ["equity"] as const },
  { key: "QUESTRADE_API_SERVER", assets: ["equity"] as const },
  { key: "FUTU_ACCOUNT_ID", assets: ["equity"] as const },
  { key: "FUTU_UNLOCK_PASSWORD", assets: ["equity"] as const },
  { key: "FUTU_HOST", assets: ["equity"] as const },
  { key: "FUTU_PORT", assets: ["equity"] as const },
  // Public Binance market-data endpoint (keyless). Always safe to inject for
  // Data Agent; legacy requests without asset class still need it.
  { key: "BINANCE_BASE_URL", assets: ["equity", "crypto"] as const },
] as const

const EQUITY_ALIASES = new Set(["equity", "equities", "stock", "stocks", "etf"])
const CRYPTO_ALIASES = new Set(["crypto", "cryptocurrency", "digital_asset", "digital assets"])

const WORKER_AGENTS = new Set([
  "data_extractor",
  "news_agent",
  "researcher",
  "research",
  "sec_agent",
  "sentiment_agent",
])

const SENSITIVE_ENV_RE = /(?:^|_)(?:API|AUTH|BROKER|CREDENTIAL|KEY|PASS|PASSWORD|SECRET|TOKEN)(?:_|$)/i

const COMMON_RUNTIME_ENV = new Set(WORKER_RUNTIME_ENV.map((key) => key.toUpperCase()))
const REGIONAL_CREDENTIAL_PREFIX: Record<string, string> = {
  zerodha: "KITE_",
  saxo: "SAXO_",
  questrade: "QUESTRADE_",
  futu: "FUTU_",
}
const ALL_REGIONAL_CREDENTIAL_PREFIXES = new Set(Object.values(REGIONAL_CREDENTIAL_PREFIX))

function normalizeAssetClass(value: unknown): "equity" | "crypto" | undefined {
  const asset = String(value ?? "")
    .toLowerCase()
    .trim()
  if (EQUITY_ALIASES.has(asset)) return "equity"
  if (CRYPTO_ALIASES.has(asset)) return "crypto"
  return undefined
}

/** Inventory of runtime keys (uppercase) for docs/tests. */
export function listWorkerRuntimeKeys(): string[] {
  return [...COMMON_RUNTIME_ENV].sort()
}

/** Inventory of data credential keys (uppercase) for docs/tests. */
export function listWorkerDataCredentialKeys(): string[] {
  return [...new Set(DATA_PROVIDER_CREDENTIALS.map((entry) => entry.key.toUpperCase()))].sort()
}

/** Credential keys allowed for a specific asset class (uppercase). */
export function dataCredentialKeysForAsset(assetClass: unknown): ReadonlySet<string> {
  const asset = normalizeAssetClass(assetClass)
  const keys = new Set<string>()
  for (const entry of DATA_PROVIDER_CREDENTIALS) {
    if (asset && (entry.assets as readonly string[]).includes(asset)) {
      keys.add(entry.key.toUpperCase())
    }
  }
  // Public Binance endpoint remains available even when asset class is missing.
  keys.add("BINANCE_BASE_URL")
  return keys
}

export function isWorkerAgent(input: { agent: string }) {
  return WORKER_AGENTS.has(input.agent)
}

function dataExtractorEnv(request?: Record<string, unknown>) {
  const allowed = new Set(COMMON_RUNTIME_ENV)
  const requestedSymbol =
    typeof request?.requested_symbol === "string"
      ? request.requested_symbol
      : Array.isArray(request?.requested_symbols) && typeof request.requested_symbols[0] === "string"
        ? request.requested_symbols[0]
        : undefined
  const regionalPrefix = requestedSymbol
    ? REGIONAL_CREDENTIAL_PREFIX[regionalMarketForTicker(requestedSymbol)?.brokerKind ?? ""]
    : undefined
  for (const key of dataCredentialKeysForAsset(request?.requested_asset_class)) {
    const keyRegionalPrefix = [...ALL_REGIONAL_CREDENTIAL_PREFIXES].find((prefix) => key.startsWith(prefix))
    if (keyRegionalPrefix && keyRegionalPrefix !== regionalPrefix) continue
    allowed.add(key)
  }
  return allowed
}

function workerEnvKeys(input: { agent: string; request?: Record<string, unknown> }) {
  return input.agent === "data_extractor" ? dataExtractorEnv(input.request) : COMMON_RUNTIME_ENV
}

function pickEnvironment(env: NodeJS.ProcessEnv, allowed: ReadonlySet<string>) {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) out[key] = value
  }
  return out
}

/** Runtime-only host environment with all provider and application secrets removed. */
export function workerRuntimeEnv(env: NodeJS.ProcessEnv) {
  return pickEnvironment(env, COMMON_RUNTIME_ENV)
}

/**
 * Build the process environment for a shell tool invocation.
 * Non-workers receive the full merged env (primary agents, user shells).
 * Workers receive only the allowlisted keys for that agent/request.
 */
export function workerShellEnv(input: { agent: string; env: NodeJS.ProcessEnv; request?: Record<string, unknown> }) {
  if (!isWorkerAgent(input)) return { ...input.env }
  return pickEnvironment(input.env, workerEnvKeys(input))
}

const BLOCKED_ENVIRONMENT_ENUMERATION = [
  /(^|[;&|()]\s*)env(?:\s|[;&|)]|$)/i,
  /\bprintenv\b/i,
  /(^|[;&|()]\s*)set\s*(?:[;&|)]|$)/i,
  /(^|[;&|()]\s*)export\s*(?:-p\s*)?(?:[;&|)]|$)/i,
  /\bcompgen\s+-e\b/i,
  /\$\{![^}]*[@*]\}/,
  /\bos\.environ\s*(?:\.(?:items|keys|values|copy)\s*\(|\)|,|$)/i,
  /\b(?:dict|list|tuple|str|repr)\s*\(\s*os\.environ\b/i,
  /\bfor\b[^\n;]*\bin\s+os\.environ\b/i,
  /\b(?:JSON\.stringify|Object\.(?:keys|values|entries|assign))\s*\(\s*process\.env\b/i,
  /\.\.\.\s*process\.env\b/i,
  /\bfor\b[^\n;]*\b(?:in|of)\s+process\.env\b/i,
  /\b(?:console\.log|process\.stdout\.write)\s*\(\s*process\.env\s*\)/i,
  /\bENV\s*\.(?:to_h|keys|values|each|inspect)\b/,
  /\b(?:puts|print|p)\s*(?:\(|\s)\s*ENV\b/,
  /\b(?:subprocess\.(?:run|call|check_output|Popen)|child_process\.(?:exec|execSync|spawn|spawnSync)|execSync|spawnSync|system)\b[^\n;]*(?:["'](?:env|printenv)["'])/i,
]

export function assertNoWorkerEnvironmentEnumeration(input: { agent: string; command: string }) {
  if (!isWorkerAgent(input)) return
  if (BLOCKED_ENVIRONMENT_ENUMERATION.some((pattern) => pattern.test(input.command))) {
    throw new Error(
      "Worker bash read blocked: commands may not enumerate the process environment. Use only the scoped provider variables required by the current request.",
    )
  }
}

export function redactSensitiveOutput(input: { text: string; env: NodeJS.ProcessEnv }) {
  let output = input.text
  const values = new Set<string>()
  for (const [key, value] of Object.entries(input.env)) {
    if (value && value.length >= 4 && SENSITIVE_ENV_RE.test(key)) values.add(value)
  }
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    output = output.replaceAll(value, "[REDACTED]")
  }
  output = output.replace(
    /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:API|AUTH|CREDENTIAL|KEY|PASS|PASSWORD|SECRET|TOKEN)[A-Za-z0-9_]*\s*[=:]\s*)([^\s"']+)/gim,
    "$1[REDACTED]",
  )
  return output.replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
    "[REDACTED]",
  )
}
