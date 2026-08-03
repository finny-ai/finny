import crypto from "crypto"
import type { BrokerAccount, BrokerCredentials, BrokerSpec } from "./types"

export const ROBINHOOD_PROVIDER_PREFIX = "robinhood-official"
/** @deprecated Compatibility only for the detached legacy integration route. */
export const ROBINHOOD_CONNECTOR_MARKER = "finny-rhx-integration"
/** @deprecated Compatibility only for the detached legacy integration route. */
export const ROBINHOOD_CONNECTOR_DUMMY_KEY = "finny-rhx-managed-no-secret"

const DEFAULT_COMMAND = "official-mcp"

const SAFE_INTEGRATION_STATUSES = new Set(["connected", "needs_auth", "failed", "disabled"])
const SAFE_CAPABILITIES = new Set(["stocks", "etfs"])

export function renderRobinhoodIntegrationContext(input: {
  status: string
  ready: boolean
  pinnedVersion: string
  capabilities: readonly string[]
}): string {
  const status = SAFE_INTEGRATION_STATUSES.has(input.status) ? input.status : "error"
  const capabilities = input.capabilities.filter((capability) => SAFE_CAPABILITIES.has(capability))

  return [
    "## Robinhood official Trading MCP state (redacted)",
    `- Connection status: ${status}`,
    `- Ready for analysis: ${input.ready ? "yes" : "no"}`,
    `- Supported asset labels: ${capabilities.length > 0 ? capabilities.join(", ") : "none"}`,
    "- Model tools are analysis-only. Trusted execution is a separate server-side preflight and risk-gateway path.",
    "- This state excludes endpoints, usernames, account identifiers, balances, OAuth tokens, and credentials.",
  ].join("\n")
}

export const robinhoodSpec: BrokerSpec = {
  kind: "robinhood",
  displayName: "Robinhood",
  mode: "live",
  providerPrefix: ROBINHOOD_PROVIDER_PREFIX,
  pythonClass: "RobinhoodBroker",
  pythonDeps: [{ spec: "yfinance>=0.2.40", importCheck: "yfinance" }],
  assetClasses: ["equity"],
  staticTakerFee: 0,
  defaultEndpoint: DEFAULT_COMMAND,
  docsUrl: "https://agent.robinhood.com",
  credentialFields: [],
  promptFragment: [
    "## Active brokerage: Robinhood (official Trading MCP)",
    "",
    "The user's algorithm runs through a daemon-owned official Robinhood Trading MCP adapter. OAuth tokens remain in the MCP client and never enter the strategy worker; strategy code must remain broker-agnostic and use `self.broker.buy/sell/position/equity/cash/price`.",
    "",
    "**Asset classes (refuse mismatches):**",
    "- Long-only US equities and ETFs in the explicit dedicated Agentic account.",
    "- Refuse options, crypto, shorts, futures, FX, mutual funds, and non-US securities.",
    "",
    "**Operational requirements:**",
    "- OAuth must be connected through the canonical Robinhood MCP server. Never request or embed credentials in strategy code.",
    "- Live execution requires a fresh server-side preflight challenge, explicit real-money acknowledgement, review before place, and reconciliation after ambiguous acknowledgement.",
    "",
    "**`config.symbol` format:**",
    '- Equity / ETF: bare ticker — `"AAPL"`, `"SPY"`.',
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
    return canonical.toUpperCase().trim()
  },
  detectAssetClass(canonical) {
    return /^[A-Z]{1,5}$/.test(canonical.toUpperCase().trim()) ? "equity" : null
  },
  envVars() {
    return {}
  },
  endpointForMode() {
    return DEFAULT_COMMAND
  },
}

export function generateRobinhoodProviderID(): string {
  return `${ROBINHOOD_PROVIDER_PREFIX}-${crypto.randomUUID()}`
}

export async function listRobinhoodAccounts(): Promise<BrokerAccount[]> {
  // Official accounts are discovered from authenticated MCP data during
  // preflight, never synthesized from generic Auth records.
  return []
}

export async function readRobinhoodCredentials(_providerID: string): Promise<BrokerCredentials | null> {
  return null
}
