import crypto from "crypto"
import { Auth } from "@/auth"
import type { BrokerAccount, BrokerConnection, BrokerCredentials, BrokerMode, BrokerSpec } from "./types"
import { brokerModeChoices } from "./live-trading"

export const IBKR_PROVIDER_PREFIX = "ibkr"

const TWS_PAPER_ENDPOINT = "127.0.0.1:7497"
const TWS_LIVE_ENDPOINT = "127.0.0.1:7496"
const GATEWAY_PAPER_ENDPOINT = "127.0.0.1:4002"
const GATEWAY_LIVE_ENDPOINT = "127.0.0.1:4001"
const DEFAULT_CONNECTION: BrokerConnection = "gateway"
const LEGACY_CONNECTION: BrokerConnection = "tws"
const DEFAULT_ENDPOINT = GATEWAY_PAPER_ENDPOINT
const DEFAULT_MODE: BrokerMode = "paper"

const CRYPTO_BASES = new Set([
  "BTC", "ETH", "SOL", "DOGE", "AVAX", "MATIC", "LINK", "DOT", "ADA",
  "XRP", "LTC", "BCH", "UNI", "AAVE", "SHIB",
])

const KNOWN_CRYPTO_QUOTES = ["USDT", "USDC", "USD"]
const IBKR_CRYPTO_QUOTE = "USD"

// Option: <UNDERLYING>/<YYYYMMDD>/<STRIKE>[CP]  e.g. SPY/20260619/500C, AAPL/20260117/175.5P
const OPTION_RE = /^([A-Z]{1,6})\/(\d{8})\/(\d+(?:\.\d+)?)([CP])$/i

// Future specific contract: <SYMBOL>/<YYYYMM>  e.g. ES/202612
const FUTURE_RE = /^([A-Z0-9]{1,5})\/(\d{6})$/i

// Continuous front-month future: <SYMBOL>/CONT  e.g. ES/CONT
const FUTURE_CONT_RE = /^([A-Z0-9]{1,5})\/CONT$/i

function isOption(symbol: string): boolean {
  return OPTION_RE.test(symbol)
}

function isFuture(symbol: string): boolean {
  return FUTURE_RE.test(symbol) || FUTURE_CONT_RE.test(symbol)
}

function splitCanonical(canonical: string): { base: string; quote: string | null } | null {
  // Don't try to parse options/futures as crypto pairs — they have their own syntaxes.
  if (isOption(canonical) || isFuture(canonical)) return null
  const u = canonical.toUpperCase().replace("-", "/").replace(".", "/")
  if (u.includes("/")) {
    const [base, quote] = u.split("/")
    if (!base) return null
    // Strict validation: must be a recognized crypto pair. Without this,
    // malformed option-shaped strings (e.g. AAA/INVALID/500C) that fail the
    // strict option regex fall through and get misclassified as crypto.
    if (quote && !KNOWN_CRYPTO_QUOTES.includes(quote) && !CRYPTO_BASES.has(base)) {
      return null
    }
    return { base, quote: quote || null }
  }
  for (const q of KNOWN_CRYPTO_QUOTES) {
    if (u.endsWith(q) && u.length > q.length) {
      return { base: u.slice(0, u.length - q.length), quote: q }
    }
  }
  if (CRYPTO_BASES.has(u)) return { base: u, quote: null }
  return null
}

function isValidMode(value: unknown): value is BrokerMode {
  return value === "paper" || value === "live"
}

function isValidConnection(value: unknown): value is BrokerConnection {
  return value === "tws" || value === "gateway"
}

function ibkrEndpointForMode(mode: BrokerMode, creds?: Pick<BrokerCredentials, "connection">): string {
  const connection = isValidConnection(creds?.connection) ? creds.connection : DEFAULT_CONNECTION
  if (connection === "gateway") return mode === "live" ? GATEWAY_LIVE_ENDPOINT : GATEWAY_PAPER_ENDPOINT
  return mode === "live" ? TWS_LIVE_ENDPOINT : TWS_PAPER_ENDPOINT
}

function legacyIbkrEndpointForMode(mode: BrokerMode): string {
  return ibkrEndpointForMode(mode, { connection: LEGACY_CONNECTION })
}

function endpointPort(endpoint: string): string {
  const stripped = endpoint.replace(/^tcp:\/\//i, "").trim()
  const idx = stripped.indexOf(":")
  return idx === -1 ? "7497" : stripped.slice(idx + 1) || "7497"
}

function parseHostPort(endpoint: string, fallbackPort = "7497"): { host: string; port: string } {
  // Accept "host:port", "host" (port defaults to the selected app/mode), or full "tcp://host:port".
  const stripped = endpoint.replace(/^tcp:\/\//i, "").trim()
  const idx = stripped.indexOf(":")
  if (idx === -1) return { host: stripped || "127.0.0.1", port: fallbackPort }
  return { host: stripped.slice(0, idx) || "127.0.0.1", port: stripped.slice(idx + 1) || fallbackPort }
}

function parseClientId(secret: string): string | undefined {
  const trimmed = secret.trim()
  return /^\d+$/.test(trimmed) ? trimmed : undefined
}

export const ibkrSpec: BrokerSpec = {
  kind: "ibkr",
  displayName: "IBKR",
  mode: DEFAULT_MODE,
  providerPrefix: IBKR_PROVIDER_PREFIX,
  pythonClass: "IBKRBroker",
  pythonDeps: [
    { spec: "ib_insync>=0.9.86", importCheck: "ib_insync" },
    { spec: "nest_asyncio>=1.5", importCheck: "nest_asyncio" },
  ],
  assetClasses: ["equity", "crypto", "option", "future"],
  staticTakerFee: 0.0005,
  defaultEndpoint: DEFAULT_ENDPOINT,
  docsUrl: "https://www.interactivebrokers.com/campus/ibkr-api-page/twsapi-doc/",
  credentialFields: [
    { name: "label", label: "Label" },
    { name: "keyId", label: "Account ID", placeholder: "DU1234567 (paper) or U1234567 (live)" },
    {
      name: "secret",
      label: "Client ID (optional)",
      placeholder: "Numeric session/client ID, e.g. 101",
      secret: true,
      required: false,
    },
    { name: "connection", label: "Connection app", default: DEFAULT_CONNECTION, choices: ["gateway", "tws"] },
    { name: "endpoint", label: "TWS / IB Gateway host:port", default: DEFAULT_ENDPOINT, placeholder: "127.0.0.1:4002" },
    { name: "mode", label: "Mode", default: DEFAULT_MODE, choices: brokerModeChoices(["paper", "live"]) },
  ],
  promptFragment: [
    "## Active brokerage: IBKR (Interactive Brokers)",
    "",
    "The user's algorithm will run against an `IBKRBroker` runtime backed by the `ib_insync` library, which talks to a locally-running TWS or IB Gateway desktop app (paper or live, picked at account-add time). The strategy stays broker-agnostic — use `self.broker.buy/sell/position/equity/cash/price`; do NOT import `ib_insync` or read `IBKR_*` env vars from strategy code. The runtime handles the TWS connection, contract qualification, and order placement.",
    "",
    "If you have multiple TWS/Gateway sessions, set **Client ID** here. If left blank, the runner generates a stable session ID per deployment.",
    "",
    "**Asset classes (refuse mismatches):**",
    "- US equities and ETFs — routed via `SMART` exchange.",
    "- Crypto — major USD pairs via IBKR's PAXOS venue.",
    "- US equity options — single-leg only; multi-leg spreads not yet supported.",
    "- US equity-index, currency, energy, metal, and grain futures (CME / CBOT / NYMEX / COMEX).",
    "- Refuse: FX spot, mutual funds, non-US equities/options/futures.",
    "",
    "**`config.symbol` format (one string per instrument):**",
    "- Equity: bare ticker — `\"AAPL\"`, `\"SPY\"`, `\"TSLA\"`.",
    "- Crypto: dot-separated USD quote — `\"BTC.USD\"`, `\"ETH.USD\"`.",
    "- Option: `\"UNDERLYING/YYYYMMDD/STRIKE[C|P]\"` — `\"SPY/20260619/500C\"` (call) or `\"AAPL/20260117/175.5P\"` (put). Decimal strikes allowed.",
    "- Future (specific contract): `\"SYMBOL/YYYYMM\"` — `\"ES/202612\"` (E-mini S&P Dec 2026), `\"CL/202609\"` (Crude Sep 2026).",
    "- Future (continuous front-month, auto-roll): `\"SYMBOL/CONT\"` — `\"ES/CONT\"`, `\"NQ/CONT\"`. **Prefer this for most futures strategies** unless the user specifically wants a fixed contract.",
    "",
    "**Sizing rules — important:**",
    "- Equity / crypto: `self.broker.buy(symbol, qty=N)` where N is shares / units.",
    "- Option: `qty` is **contracts** (1 contract = 100 shares of underlying). The runtime correctly accounts for the 100× multiplier when sizing default-cash buys, but always size explicitly for clarity.",
    "- Future: `qty` is **contracts**. Default all-cash buys are **refused** for futures because futures use margin, not cash — the runtime cannot infer a safe size. ALWAYS pass explicit `qty=N` for futures.",
    "",
    "**Required first line of the saved `code`:**",
    "```python",
    "# Target broker: IBKR",
    "```",
    "Without this comment the saved strategy is anonymous in code review. Always include it.",
  ].join("\n"),
  normalizeSymbol(canonical) {
    return ibkrSpec.resolvePair(canonical)
  },
  resolvePair(canonical) {
    const u = canonical.toUpperCase()
    // Options + futures pass through unchanged — they're already in IBKR's canonical form.
    if (isOption(u) || isFuture(u)) return u
    const split = splitCanonical(canonical)
    if (split) {
      return `${split.base}.${IBKR_CRYPTO_QUOTE}`
    }
    if (/^[A-Z]{1,5}$/.test(u)) return u
    return u
  },
  detectAssetClass(canonical) {
    const u = canonical.toUpperCase()
    if (isOption(u)) return "option"
    if (isFuture(u)) return "future"
    if (splitCanonical(canonical)) return "crypto"
    if (/^[A-Z]{1,5}$/.test(u)) return "equity"
    return null
  },
  envVars(creds) {
    const mode = isValidMode(creds.mode) ? creds.mode : DEFAULT_MODE
    const connection = isValidConnection(creds.connection) ? creds.connection : LEGACY_CONNECTION
    const canonical = ibkrEndpointForMode(mode, { connection })
    // If the user toggled mode after saving, fall back to the canonical
    // host:port for the active mode rather than silently using the wrong port.
    const opposite = ibkrEndpointForMode(mode === "live" ? "paper" : "live", { connection })
    const endpoint = creds.endpoint && creds.endpoint !== opposite ? creds.endpoint : canonical
    const { host, port } = parseHostPort(endpoint, endpointPort(canonical))
    const clientId = parseClientId(creds.secret)
    return {
      IBKR_ACCOUNT_ID: creds.keyId,
      IBKR_HOST: host,
      IBKR_PORT: port,
      IBKR_MODE: mode,
      IBKR_CONNECTION_APP: connection,
      ...(clientId ? { IBKR_CLIENT_ID: clientId } : {}),
    }
  },
  endpointForMode: ibkrEndpointForMode,
}

function isIbkrKey(key: string): boolean {
  return key === IBKR_PROVIDER_PREFIX || key.startsWith(`${IBKR_PROVIDER_PREFIX}-`)
}

export function generateIbkrProviderID(): string {
  return `${IBKR_PROVIDER_PREFIX}-${crypto.randomUUID()}`
}

export async function listIbkrAccounts(): Promise<BrokerAccount[]> {
  const all = await Auth.all()
  const accounts: BrokerAccount[] = []
  for (const [key, info] of Object.entries(all)) {
    if (!isIbkrKey(key)) continue
    if (info.type !== "api") continue
    const meta = (info as any).metadata ?? {}
    const mode = isValidMode(meta.mode) ? meta.mode : DEFAULT_MODE
    const hasConnection = isValidConnection(meta.connection)
    const connection = hasConnection ? meta.connection : LEGACY_CONNECTION
    const fallbackEndpoint = hasConnection ? ibkrEndpointForMode(mode, { connection }) : legacyIbkrEndpointForMode(mode)
    accounts.push({
      providerID: key,
      brokerKind: "ibkr",
      label: meta.label ?? "Default",
      keyId: meta.keyId ?? "",
      endpoint: meta.endpoint ?? fallbackEndpoint,
      mode,
      connection,
    })
  }
  return accounts
}

export async function readIbkrCredentials(providerID: string): Promise<BrokerCredentials | null> {
  const info = await Auth.get(providerID)
  if (!info || info.type !== "api") return null
  const meta = (info as any).metadata ?? {}
  const keyId = meta.keyId
  if (!keyId) return null
  const mode = isValidMode(meta.mode) ? meta.mode : DEFAULT_MODE
  const hasConnection = isValidConnection(meta.connection)
  const connection = hasConnection ? meta.connection : LEGACY_CONNECTION
  const fallbackEndpoint = hasConnection ? ibkrEndpointForMode(mode, { connection }) : legacyIbkrEndpointForMode(mode)
  return {
    keyId,
    // Client ID is optional; if not provided, Python runner defaults using
    // the run_id-derived stable id.
    secret: info.key ?? "",
    endpoint: meta.endpoint ?? fallbackEndpoint,
    mode,
    connection,
  }
}
