import { createHash } from "node:crypto"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "@/agent/agent"
import { EngineV2 } from "@/backtest/results"
import { LeanAdapter } from "@/backtest/lean/adapter"
import { qcCredentialPresentSync } from "@/integration/quantconnect"
import { Permission } from "@/permission"
import { PRICE_HISTORY_INTERVALS, PRICE_HISTORY_RETENTION } from "@/tool/price-history"
import type { Tool } from "@/tool/tool"
import { effectiveFundRuntimePermission } from "@/agent/fund-policy"

export const CAPABILITY_MANIFEST_VERSION = "2.0.0"

export type CapabilityPhase = "strategy" | "build" | "research" | "chat" | "portfolio" | "subagent" | "internal"

export interface CapabilityManifest {
  version: string
  hash: string
  phase: CapabilityPhase
  selectedCapabilities: string[]
  tools: Array<{
    id: string
    availability: "available" | "approval_required" | "unavailable"
    unavailableReason?: string
    requiredInputs: string[]
    inputSchema: JSONSchema7
    outputSchema: string
    summary: string
  }>
  agents: Array<{
    id: string
    canonicalId: string
    aliases: string[]
    availability: "available" | "approval_required" | "unavailable"
    unavailableReason?: string
  }>
  data?: {
    providers: Array<{
      id: string
      credentialReadiness: "ready"
      credentialReason: string
      assetClasses: string[]
      intervals: string[]
      retentionLimits: Record<string, string>
    }>
  }
  backtest?: {
    engine: { id: "engine_v2"; schemaMajor: number; executionTiming: "next_bar_open" }
    metrics: string[]
    robustnessTests: string[]
    benchmarks: string[]
    costs: string[]
    calendars: string[]
    qualityGates: string[]
    artifacts: Record<string, string>
    /** Additive LEAN runtime advertisement; populated only when ready. */
    runtimes?: LeanRuntimeAdvertisement
  }
  unsupported: Array<{ id: string; reason: string; recovery?: string }>
  blockers: Array<{ class: string; recovery: string }>
}

const AGENT_ALIASES: Record<string, string> = { researcher: "news_agent" }

const PHASE_BY_AGENT: Record<string, CapabilityPhase> = {
  finny: "strategy",
  build: "build",
  research: "research",
  chat: "chat",
  portfolio_builder: "portfolio",
  data_extractor: "subagent",
  news_agent: "subagent",
  researcher: "subagent",
  sec_agent: "subagent",
  sentiment_agent: "subagent",
}

const PHASE_TOOLS: Record<CapabilityPhase, readonly string[]> = {
  strategy: ["task", "finny_"],
  build: ["task", "finny_"],
  // Keep aligned with finnyResearchTools / research agent contracts (incl. pinned params).
  research: ["task", "finny_get_quote", "finny_get_history", "finny_algorithm_set_params"],
  chat: ["task", "finny_get_quote", "finny_get_history", "finny_algorithm_", "finny_backtest_history"],
  // portfolio_builder is recommendation-only; market data lookups only.
  portfolio: ["finny_get_quote", "finny_get_history"],
  subagent: ["finny_"],
  internal: [],
}

const BACKTEST_METRICS = [
  "total_return",
  "cagr",
  "sharpe",
  "sortino",
  "calmar",
  "max_drawdown",
  "profit_factor",
  "max_gross_exposure",
  "time_in_market",
  "turnover",
  "fees",
  "funding",
  "borrow",
  "alpha",
  "beta",
  "information_ratio",
  "deflated_sharpe_probability",
  "probabilistic_sharpe_ratio",
] as const

export type LeanRuntimeAdvertisement = Array<{
  profileId: "lean_python" | "lean_csharp" | "qc_cloud"
  availability: "available" | "unavailable"
  reasons: string[]
}>

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function withHash(input: Omit<CapabilityManifest, "hash">): CapabilityManifest {
  return { ...input, hash: createHash("sha256").update(stable(input)).digest("hex") }
}

function relevantTool(phase: CapabilityPhase, id: string) {
  return PHASE_TOOLS[phase].some((prefix) => id === prefix || id.startsWith(prefix))
}

function availability(rule: PermissionV1.Rule) {
  if (rule.action === "allow") return { availability: "available" as const }
  if (rule.action === "ask") return { availability: "approval_required" as const }
  return { availability: "unavailable" as const, unavailableReason: "denied_by_session_or_agent_permission" }
}

function requiredInputs(schema: JSONSchema7): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string").toSorted()
    : []
}

function compactSchemaDefinition(schema: JSONSchema7Definition): JSONSchema7Definition {
  return typeof schema === "boolean" ? schema : compactSchema(schema)
}

function compactSchemaScalars(schema: JSONSchema7): JSONSchema7 {
  const compact: JSONSchema7 = {}
  const keys = ["type", "enum", "const", "default", "pattern", "minimum", "maximum", "required"] as const
  for (const key of keys) {
    const value = schema[key]
    if (value !== undefined) Object.assign(compact, { [key]: value })
  }
  return compact
}

function compactSchemaProperties(schema: JSONSchema7): Pick<JSONSchema7, "properties"> {
  if (!schema.properties) return {}
  return {
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, compactSchemaDefinition(value)]),
    ),
  }
}

function compactSchemaItems(schema: JSONSchema7): Pick<JSONSchema7, "items"> {
  if (schema.items === undefined) return {}
  return {
    items: Array.isArray(schema.items)
      ? schema.items.map(compactSchemaDefinition)
      : compactSchemaDefinition(schema.items),
  }
}

function compactSchemaAlternatives(schema: JSONSchema7): Pick<JSONSchema7, "anyOf" | "oneOf"> {
  return {
    ...(schema.anyOf ? { anyOf: schema.anyOf.map(compactSchemaDefinition) } : {}),
    ...(schema.oneOf ? { oneOf: schema.oneOf.map(compactSchemaDefinition) } : {}),
  }
}

function compactSchema(schema: JSONSchema7): JSONSchema7 {
  return {
    ...compactSchemaScalars(schema),
    ...compactSchemaProperties(schema),
    ...compactSchemaItems(schema),
    ...compactSchemaAlternatives(schema),
  }
}

function aliasesFor(id: string) {
  return Object.entries(AGENT_ALIASES)
    .filter(([, canonical]) => canonical === id)
    .map(([alias]) => alias)
    .toSorted()
}

export function buildCapabilityManifest(input: {
  agent: Agent.Info
  agents: Agent.Info[]
  tools: Tool.Def[]
  sessionPermission?: PermissionV1.Ruleset
}): CapabilityManifest {
  const phase = PHASE_BY_AGENT[input.agent.name] ?? "internal"
  const ruleset = effectiveFundRuntimePermission(
    input.agent.name,
    input.agent.permission,
    input.sessionPermission ?? [],
  )
  const tools = capabilityTools(input.tools, phase, ruleset)
  const agents = capabilityAgents(input.agents, ruleset)
  const selectedCapabilities = selectedCapabilityIDs(tools, agents)

  return withHash({
    version: CAPABILITY_MANIFEST_VERSION,
    phase,
    selectedCapabilities,
    tools,
    agents,
    ...dataCapabilities(tools),
    ...backtestCapabilities(tools),
    unsupported: unsupportedCapabilities(),
    blockers: blockerCapabilities(),
  })
}

function capabilityTools(tools: Tool.Def[], phase: CapabilityPhase, ruleset: PermissionV1.Ruleset) {
  return tools
    .filter((tool) => relevantTool(phase, tool.id))
    .map((tool) => {
      const state = availability(Permission.evaluate(tool.id, "*", ruleset))
      const schema = tool.jsonSchema ?? ({ type: "object" } satisfies JSONSchema7)
      return {
        id: tool.id,
        ...state,
        requiredInputs: requiredInputs(schema),
        inputSchema: compactSchema(schema),
        outputSchema:
          tool.id === "finny_backtest" ? `engine_v2.report.v${EngineV2.SCHEMA_VERSION_MAJOR}` : "tool_result.v1",
        summary: tool.description.split(/(?<=[.!?])\s/, 1)[0]!.slice(0, 200),
      }
    })
    .filter((tool) => tool.availability !== "unavailable")
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

function capabilityAgents(agents: Agent.Info[], ruleset: PermissionV1.Ruleset) {
  return agents
    .filter((item) => item.mode === "subagent")
    .map((item) => {
      const canonicalId = AGENT_ALIASES[item.name] ?? item.name
      const state = availability(Permission.evaluate("task", item.name, ruleset))
      // Only advertise aliases that are themselves permitted for task(...).
      // e.g. finny strategy mode allows news_agent but not the researcher alias.
      const aliases =
        item.name === canonicalId
          ? aliasesFor(item.name).filter(
              (alias) => availability(Permission.evaluate("task", alias, ruleset)).availability !== "unavailable",
            )
          : []
      return {
        id: item.name,
        canonicalId,
        aliases,
        ...state,
      }
    })
    .filter((item) => item.availability !== "unavailable")
    .toSorted((a, b) => a.id.localeCompare(b.id))
}

function selectedCapabilityIDs(tools: CapabilityManifest["tools"], agents: CapabilityManifest["agents"]): string[] {
  return [...tools.map((tool) => `tool:${tool.id}`), ...agents.map((agent) => `agent:${agent.canonicalId}`)]
    .filter((item, index, all) => all.indexOf(item) === index)
    .toSorted()
}

function dataCapabilities(tools: CapabilityManifest["tools"]): Pick<CapabilityManifest, "data"> | {} {
  const ids = new Set(tools.map((tool) => tool.id))
  if (!["finny_get_quote", "finny_get_history", "finny_backtest"].some((id) => ids.has(id))) return {}
  return {
    data: {
      providers: [
        {
          id: "yfinance",
          credentialReadiness: "ready",
          credentialReason: "keyless_managed_runtime",
          assetClasses: ["equity", "etf", "crypto"],
          intervals: [...PRICE_HISTORY_INTERVALS],
          retentionLimits: { ...PRICE_HISTORY_RETENTION },
        },
      ],
    },
  }
}

function backtestCapabilities(tools: CapabilityManifest["tools"]): Pick<CapabilityManifest, "backtest"> | {} {
  const ids = new Set(tools.map((tool) => tool.id))
  if (!["finny_backtest", "finny_portfolio_backtest"].some((id) => ids.has(id))) return {}
  const readiness = leanRuntimeReadiness()
  return {
    backtest: {
      engine: {
        id: "engine_v2",
        schemaMajor: EngineV2.SCHEMA_VERSION_MAJOR,
        executionTiming: "next_bar_open",
      },
      metrics: [...BACKTEST_METRICS],
      robustnessTests: ["walk_forward", "monte_carlo", "regime_breakdown", "consistency", "alpha_decay"],
      benchmarks: ["buy_and_hold", "alpha", "beta", "information_ratio"],
      costs: ["fees", "slippage", "spread", "funding", "borrow"],
      calendars: ["equity_exchange", "crypto_24_7"],
      qualityGates: [
        "data_quality",
        "minimum_trades",
        "walk_forward_folds",
        "benchmark_relative",
        "deterministic_verdict",
      ],
      artifacts: {
        report: `engine_v2.report.v${EngineV2.SCHEMA_VERSION_MAJOR}`,
        run: "finny.run.v1",
        reviewPacket: "finny.review_packet.v1",
      },
      ...(readiness ? { runtimes: readiness } : {}),
    },
  }
}

function leanRuntimeReadiness(): LeanRuntimeAdvertisement {
  const probe = new LeanAdapter().probeReady()
  const qcPresent = qcCredentialPresentSync()
  return [
    {
      profileId: "lean_python",
      availability: probe.ready ? "available" : "unavailable",
      reasons: probe.reasons,
    },
    {
      profileId: "lean_csharp",
      availability: "unavailable",
      reasons: ["lean_csharp runtime is not part of the first release"],
    },
    {
      profileId: "qc_cloud",
      availability: qcPresent ? "available" : "unavailable",
      reasons: qcPresent
        ? []
        : ["no QuantConnect credentials linked; run `opencode qc connect --user-id <id> --api-token <token>`"],
    },
  ]
}

function unsupportedCapabilities(): CapabilityManifest["unsupported"] {
  return [
    {
      id: "custom_product_backtest_runner",
      reason: "unsupported_deprecated_path",
      recovery: "Use finny_backtest with a saved Finny algorithm.",
    },
    {
      id: "yfinance_4h_history",
      reason: "provider_has_no_native_4h_interval",
      recovery: "Use 1h data or the strict backtest engine's supported 4h resampling path.",
    },
  ]
}

function blockerCapabilities(): CapabilityManifest["blockers"] {
  return [
    { class: "validation_failed", recovery: "Fix validator errors before backtesting." },
    {
      class: "data_blocked",
      recovery:
        "Report Crucible's provider-collection blocker for the exact requested symbol, interval, asset class, and dates.",
    },
    {
      class: "data_quality_failed",
      recovery: "Report Crucible's strict quality facts and keep the confirmed request unchanged.",
    },
    { class: "insufficient_walk_forward", recovery: "Use a longer duration or coarser interval." },
    {
      class: "engine_failed",
      recovery: "Inspect the deterministic engine error and do not substitute a custom runner.",
    },
    { class: "quality_gate_failed", recovery: "Report the failed gate; do not claim paper eligibility." },
  ]
}

export function capabilityManifestSystemFragment(manifest: CapabilityManifest) {
  return `<finny_capability_manifest>${JSON.stringify(manifest)}</finny_capability_manifest>`
}
