import { ModelV2 } from "@opencode-ai/core/model"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const FUND_MANAGER_AGENT = "fund_manager" as const

export const FUND_SPECIALIST_AGENTS = [
  "fund_strategy_researcher",
  "fund_regime_analyst",
  "fund_fill_auditor",
  "fund_risk_analyst",
  "fund_code_change_agent",
  "fund_independent_validator",
  "fund_deployment_adviser",
  "fund_risk_sentinel",
] as const

export const FUND_ACTION_TYPES = [
  "no_change",
  "request_analysis",
  "propose_pause",
  "propose_resume",
  "propose_strategy_build",
  "propose_strategy_deploy",
  "propose_strategy_rollback",
  "propose_logic_change",
  "propose_paper_allocation_change",
] as const

export type FundActionType = (typeof FUND_ACTION_TYPES)[number]
export type FundRiskTier = "observation" | "bounded_paper" | "material_change"

export const FUND_ACTION_POLICY = {
  no_change: {
    riskTier: "observation",
    requiredSpecialists: [],
  },
  request_analysis: {
    riskTier: "observation",
    requiredSpecialists: [],
  },
  propose_pause: {
    riskTier: "bounded_paper",
    requiredSpecialists: ["fund_risk_analyst", "fund_risk_sentinel"],
  },
  propose_resume: {
    riskTier: "material_change",
    requiredSpecialists: ["fund_independent_validator", "fund_risk_sentinel"],
  },
  propose_strategy_build: {
    riskTier: "bounded_paper",
    requiredSpecialists: ["fund_strategy_researcher", "fund_risk_analyst"],
  },
  propose_strategy_deploy: {
    riskTier: "material_change",
    requiredSpecialists: [
      "fund_strategy_researcher",
      "fund_independent_validator",
      "fund_deployment_adviser",
      "fund_risk_sentinel",
    ],
  },
  propose_strategy_rollback: {
    riskTier: "bounded_paper",
    requiredSpecialists: ["fund_independent_validator", "fund_deployment_adviser", "fund_risk_sentinel"],
  },
  propose_logic_change: {
    riskTier: "material_change",
    requiredSpecialists: ["fund_code_change_agent", "fund_independent_validator", "fund_risk_sentinel"],
  },
  propose_paper_allocation_change: {
    riskTier: "material_change",
    requiredSpecialists: ["fund_risk_analyst", "fund_independent_validator", "fund_risk_sentinel"],
  },
} as const satisfies Record<
  FundActionType,
  {
    riskTier: FundRiskTier
    requiredSpecialists: readonly FundSpecialistAgent[]
  }
>

export const FUND_DRAFT_REVIEWERS = ["fund_independent_validator", "fund_risk_sentinel"] as const

export type FundSpecialistAgent = (typeof FUND_SPECIALIST_AGENTS)[number]

export const FUND_SPECIALIST_ROLE_BY_AGENT = {
  fund_strategy_researcher: "strategy_researcher",
  fund_regime_analyst: "regime_analyst",
  fund_fill_auditor: "fill_auditor",
  fund_risk_analyst: "risk_analyst",
  fund_code_change_agent: "code_change_agent",
  fund_independent_validator: "independent_validator",
  fund_deployment_adviser: "deployment_adviser",
  fund_risk_sentinel: "risk_sentinel",
} as const satisfies Record<FundSpecialistAgent, string>

export type FundSpecialistRole = (typeof FUND_SPECIALIST_ROLE_BY_AGENT)[FundSpecialistAgent]

export const FUND_RUNTIME_MODEL = {
  providerID: ProviderV2.ID.make("google"),
  modelID: ModelV2.ID.make("gemini-3.6-flash"),
} as const

const FUND_SPECIALIST_AGENT_SET = new Set<string>(FUND_SPECIALIST_AGENTS)
const FUND_RUNTIME_AGENT_SET = new Set<string>([FUND_MANAGER_AGENT, ...FUND_SPECIALIST_AGENTS])
const DEPRECATED_SAMPLING_KEYS = new Set(["temperature", "top_p", "topP", "top_k", "topK"])

const FUND_MANAGER_PERMISSION_SEAL: PermissionV1.Ruleset = [
  { permission: "*", pattern: "*", action: "deny" },
  ...FUND_SPECIALIST_AGENTS.map((agent) => ({
    permission: "task",
    pattern: agent,
    action: "allow" as const,
  })),
  { permission: "finny_fund_action_draft", pattern: "*", action: "allow" },
  { permission: "finny_fund_action_propose", pattern: "*", action: "allow" },
]

const FUND_SPECIALIST_PERMISSION_SEAL: PermissionV1.Ruleset = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "finny_fund_specialist_report", pattern: "*", action: "allow" },
]

export function isFundManagerAgent(agent: string | undefined): agent is typeof FUND_MANAGER_AGENT {
  return agent === FUND_MANAGER_AGENT
}

export function isFundSpecialistAgent(agent: string | undefined): agent is FundSpecialistAgent {
  return !!agent && FUND_SPECIALIST_AGENT_SET.has(agent)
}

export function isFundRuntimeAgent(agent: string | undefined): boolean {
  return !!agent && FUND_RUNTIME_AGENT_SET.has(agent)
}

export function fundRuntimePermissionSeal(agent: string | undefined): PermissionV1.Ruleset {
  if (isFundManagerAgent(agent)) return [...FUND_MANAGER_PERMISSION_SEAL]
  if (isFundSpecialistAgent(agent)) return [...FUND_SPECIALIST_PERMISSION_SEAL]
  return []
}

export function effectiveFundRuntimePermission(
  agent: string | undefined,
  agentPermission: PermissionV1.Ruleset,
  sessionPermission: PermissionV1.Ruleset = [],
): PermissionV1.Ruleset {
  return [...agentPermission, ...sessionPermission, ...fundRuntimePermissionSeal(agent)]
}

export function fundSpecialistRole(agent: string | undefined): FundSpecialistRole | undefined {
  if (!isFundSpecialistAgent(agent)) return undefined
  return FUND_SPECIALIST_ROLE_BY_AGENT[agent]
}

export function isFundRuntimeModel(input: { providerID: string; modelID?: string; id?: string }): boolean {
  return (
    input.providerID === FUND_RUNTIME_MODEL.providerID && (input.modelID ?? input.id) === FUND_RUNTIME_MODEL.modelID
  )
}

export function fundModelCompatibilityError(input: {
  agent: string
  providerID: string
  modelID: string
}): string | undefined {
  if (!isFundRuntimeAgent(input.agent)) return undefined
  if (isFundRuntimeModel(input)) return undefined
  return (
    `Agent "${input.agent}" is locked to ` +
    `${FUND_RUNTIME_MODEL.providerID}/${FUND_RUNTIME_MODEL.modelID}; received ${input.providerID}/${input.modelID}.`
  )
}

export function fundDelegationError(parentAgent: string, subagentType: string): string | undefined {
  if (isFundSpecialistAgent(parentAgent)) {
    return `Fund specialist "${parentAgent}" cannot delegate nested tasks.`
  }
  if (isFundManagerAgent(parentAgent) && !isFundSpecialistAgent(subagentType)) {
    return `Fund Manager may delegate only to registered fund specialists; "${subagentType}" is not allowed.`
  }
  if (isFundSpecialistAgent(subagentType) && !isFundManagerAgent(parentAgent)) {
    return `Fund specialist "${subagentType}" may be launched only by "${FUND_MANAGER_AGENT}".`
  }
  return undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function deprecatedSamplingOptionPaths(value: unknown, prefix = "options"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => deprecatedSamplingOptionPaths(item, `${prefix}[${index}]`))
  }
  if (!isPlainObject(value)) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const path = `${prefix}.${key}`
    return [...(DEPRECATED_SAMPLING_KEYS.has(key) ? [path] : []), ...deprecatedSamplingOptionPaths(child, path)]
  })
}

export function stripDeprecatedSamplingOptions<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripDeprecatedSamplingOptions(item)) as T
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DEPRECATED_SAMPLING_KEYS.has(key))
      .map(([key, child]) => [key, stripDeprecatedSamplingOptions(child)]),
  ) as T
}

export function fundAgentConfigError(input: {
  agent: string
  configuredName?: string
  disabled?: boolean
  model?: string
  temperature?: number
  topP?: number
  options?: Record<string, unknown>
}): string | undefined {
  if (input.disabled && isFundRuntimeAgent(input.agent)) {
    return `Protected fund runtime role "${input.agent}" cannot be disabled.`
  }
  if (
    input.configuredName &&
    input.configuredName !== input.agent &&
    (isFundRuntimeAgent(input.agent) || isFundRuntimeAgent(input.configuredName))
  ) {
    return (
      `Agent "${input.agent}" cannot rename itself to or from protected fund runtime role ` +
      `"${input.configuredName}".`
    )
  }
  if (!isFundRuntimeAgent(input.agent)) return undefined
  if (input.model) {
    const [providerID, ...rest] = input.model.split("/")
    const modelID = rest.join("/")
    const mismatch = fundModelCompatibilityError({ agent: input.agent, providerID, modelID })
    if (mismatch) return mismatch
  }
  const deprecated = [
    ...(input.temperature !== undefined ? ["temperature"] : []),
    ...(input.topP !== undefined ? ["top_p"] : []),
    ...deprecatedSamplingOptionPaths(input.options ?? {}),
  ]
  if (deprecated.length === 0) return undefined
  return (
    `Agent "${input.agent}" cannot configure deprecated sampling parameters for ` +
    `${FUND_RUNTIME_MODEL.providerID}/${FUND_RUNTIME_MODEL.modelID}: ${deprecated.join(", ")}.`
  )
}

export function sanitizeFundModelRequestParams<
  T extends {
    temperature?: number
    topP?: number
    topK?: number
    options: Record<string, unknown>
  },
>(
  model: { providerID: string; modelID?: string; id?: string },
  params: T,
): Omit<T, "temperature" | "topP" | "topK" | "options"> & {
  temperature?: number
  topP?: number
  topK?: number
  options: Record<string, unknown>
} {
  if (!isFundRuntimeModel(model)) return params
  return {
    ...params,
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    options: stripDeprecatedSamplingOptions(params.options),
  }
}
