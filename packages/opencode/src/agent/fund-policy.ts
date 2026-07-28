import { ModelV2 } from "@opencode-ai/core/model"
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

export function isFundManagerAgent(agent: string | undefined): agent is typeof FUND_MANAGER_AGENT {
  return agent === FUND_MANAGER_AGENT
}

export function isFundSpecialistAgent(agent: string | undefined): agent is FundSpecialistAgent {
  return !!agent && FUND_SPECIALIST_AGENT_SET.has(agent)
}

export function isFundRuntimeAgent(agent: string | undefined): boolean {
  return !!agent && FUND_RUNTIME_AGENT_SET.has(agent)
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
  model?: string
  temperature?: number
  topP?: number
  options?: Record<string, unknown>
}): string | undefined {
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
