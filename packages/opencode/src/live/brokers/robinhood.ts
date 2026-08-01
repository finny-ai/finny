import crypto from "crypto"
import { Auth } from "@/auth"
import type { BrokerAccount, BrokerCredentials, BrokerSpec } from "./types"

export const ROBINHOOD_PROVIDER_PREFIX = "robinhood-rhx"

const DEFAULT_COMMAND = "rhx"
const DEFAULT_PROFILE = "default"
const PINNED_RHX_VERSION = "0.4.8"
const VERIFICATION_TTL_MS = 5 * 60 * 1000

const SAFE_INTEGRATION_STATUSES = new Set([
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
const SAFE_CAPABILITIES = new Set(["stocks", "etfs", "crypto-usd"])

export function renderRobinhoodIntegrationContext(input: {
  status: string
  ready: boolean
  pinnedVersion: string
  capabilities: readonly string[]
}): string {
  const status = SAFE_INTEGRATION_STATUSES.has(input.status) ? input.status : "error"
  const version = input.pinnedVersion === PINNED_RHX_VERSION ? PINNED_RHX_VERSION : "unverified"
  const capabilities = input.capabilities.filter((capability) => SAFE_CAPABILITIES.has(capability))

  return [
    "## Robinhood connector state (redacted)",
    `- Managed RHX version: ${version}`,
    `- Connector status: ${status}`,
    `- Ready for broker operations: ${input.ready ? "yes" : "no"}`,
    `- Supported capability labels: ${capabilities.length > 0 ? capabilities.join(", ") : "none"}`,
    "- This state intentionally excludes profiles, executable paths, usernames, account identifiers, balances, tokens, and credentials.",
    "- If setup needs attention, direct the user to `/robinhood`; never ask for Robinhood secrets in chat.",
  ].join("\n")
}

const CRYPTO_BASES = new Set([
  "BTC",
  "ETH",
  "SOL",
  "DOGE",
  "AVAX",
  "MATIC",
  "LINK",
  "DOT",
  "ADA",
  "XRP",
  "LTC",
  "BCH",
  "UNI",
  "AAVE",
  "SHIB",
])

function splitCryptoPair(canonical: string): { base: string; quote: "USD" } | null {
  const normalized = canonical.toUpperCase().trim().replace("/", "-")
  if (normalized.includes("-")) {
    const [base, quote, extra] = normalized.split("-")
    if (!base || quote !== "USD" || extra) return null
    return { base, quote: "USD" }
  }
  if (normalized.endsWith("USD") && normalized.length > 3) {
    return { base: normalized.slice(0, -3), quote: "USD" }
  }
  if (CRYPTO_BASES.has(normalized)) return { base: normalized, quote: "USD" }
  return null
}

export const robinhoodSpec: BrokerSpec = {
  kind: "robinhood",
  displayName: "Robinhood",
  mode: "live",
  providerPrefix: ROBINHOOD_PROVIDER_PREFIX,
  pythonClass: "RobinhoodBroker",
  pythonDeps: [{ spec: "yfinance>=0.2.40", importCheck: "yfinance" }],
  assetClasses: ["equity", "crypto"],
  // Equity commissions are zero, while crypto pricing/fees vary by route and
  // tier. Keep comparison deterministic and let the broker response remain the
  // source of truth for execution costs.
  staticTakerFee: 0,
  defaultEndpoint: DEFAULT_COMMAND,
  docsUrl: "https://github.com/finlayi/robinhood-cli",
  credentialFields: [
    { name: "label", label: "Label" },
    {
      name: "keyId",
      label: "rhx profile",
      placeholder: "Profile created by `rhx auth login`",
      default: DEFAULT_PROFILE,
    },
    {
      name: "endpoint",
      label: "rhx executable",
      placeholder: "rhx or an absolute path",
      default: DEFAULT_COMMAND,
    },
  ],
  promptFragment: [
    "## Active brokerage: Robinhood (rhx CLI)",
    "",
    "The user's algorithm runs through a `RobinhoodBroker` adapter backed by the `rhx` CLI. Credentials, MFA, sessions, and Robinhood API details stay inside rhx; strategy code must remain broker-agnostic and use `self.broker.buy/sell/position/equity/cash/price`.",
    "",
    "**Asset classes (refuse mismatches):**",
    "- US equities and ETFs through rhx's brokerage provider.",
    "- Crypto through Robinhood's official Crypto Trading API. Use USD pairs only.",
    "- Refuse options, futures, FX, mutual funds, and non-US securities for automated strategy deployment.",
    "",
    "**Operational requirements:**",
    "- The configured rhx profile must already be authenticated. Never request or embed a Robinhood password in strategy code.",
    "- Stock brokerage endpoints used by rhx are unofficial and can change. Crypto uses the official API credential path.",
    "- This Finny release is shadow-only: the execution risk gateway does not submit Robinhood orders. A future live-enabled release would still require both Finny approval and a current `RHX_LIVE_CONFIRM_TOKEN`; missing or expired tokens fail closed.",
    "",
    "**`config.symbol` format:**",
    '- Equity / ETF: bare ticker — `"AAPL"`, `"SPY"`.',
    '- Crypto: `"BASE-USD"` — `"BTC-USD"`, `"ETH-USD"`.',
    "",
    "**Required first line of the saved `code`:**",
    "```python",
    "# Target broker: Robinhood",
    "```",
  ].join("\n"),
  normalizeSymbol(canonical) {
    return robinhoodSpec.resolvePair(canonical)
  },
  resolvePair(canonical) {
    const crypto = splitCryptoPair(canonical)
    return crypto ? `${crypto.base}-USD` : canonical.toUpperCase().trim()
  },
  detectAssetClass(canonical) {
    if (splitCryptoPair(canonical)) return "crypto"
    return /^[A-Z]{1,5}$/.test(canonical.toUpperCase().trim()) ? "equity" : null
  },
  envVars(creds) {
    return {
      RHX_PROFILE: creds.keyId || DEFAULT_PROFILE,
      RHX_BIN: creds.endpoint || DEFAULT_COMMAND,
      ROBINHOOD_MODE: "live",
    }
  },
  endpointForMode() {
    return DEFAULT_COMMAND
  },
}

function isRobinhoodKey(key: string): boolean {
  return key === ROBINHOOD_PROVIDER_PREFIX || key.startsWith(`${ROBINHOOD_PROVIDER_PREFIX}-`)
}

export function generateRobinhoodProviderID(): string {
  return `${ROBINHOOD_PROVIDER_PREFIX}-${crypto.randomUUID()}`
}

export async function listRobinhoodAccounts(): Promise<BrokerAccount[]> {
  const all = await Auth.all()
  const accounts: BrokerAccount[] = []
  for (const [key, info] of Object.entries(all)) {
    if (!isRobinhoodKey(key) || info.type !== "api") continue
    const meta = (info as any).metadata ?? {}
    const profile = typeof meta.keyId === "string" && meta.keyId.trim() ? meta.keyId.trim() : DEFAULT_PROFILE
    const hasReadinessMetadata = meta.brokerageReady !== undefined || meta.cryptoReady !== undefined
    const verifiedAt = typeof meta.verifiedAt === "string" ? Date.parse(meta.verifiedAt) : Number.NaN
    const verificationFresh =
      Number.isFinite(verifiedAt) && Date.now() >= verifiedAt && Date.now() - verifiedAt <= VERIFICATION_TTL_MS
    const assetClasses = hasReadinessMetadata
      ? ([
          ...(verificationFresh && meta.brokerageReady === "true" ? ["equity" as const] : []),
          ...(verificationFresh && meta.cryptoReady === "true" ? ["crypto" as const] : []),
        ] satisfies BrokerAccount["assetClasses"])
      : undefined
    accounts.push({
      providerID: key,
      brokerKind: "robinhood",
      label: meta.label ?? "Default",
      keyId: profile,
      endpoint: typeof meta.endpoint === "string" && meta.endpoint.trim() ? meta.endpoint.trim() : DEFAULT_COMMAND,
      mode: "live",
      ...(assetClasses ? { assetClasses } : {}),
    })
  }
  return accounts
}

export async function readRobinhoodCredentials(providerID: string): Promise<BrokerCredentials | null> {
  const info = await Auth.get(providerID)
  if (!info || info.type !== "api") return null
  const meta = (info as any).metadata ?? {}
  const profile = typeof meta.keyId === "string" ? meta.keyId.trim() : ""
  if (!profile) return null
  return {
    keyId: profile,
    secret: "",
    endpoint: typeof meta.endpoint === "string" && meta.endpoint.trim() ? meta.endpoint.trim() : DEFAULT_COMMAND,
    mode: "live",
  }
}
