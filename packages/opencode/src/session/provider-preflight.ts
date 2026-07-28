import type { Auth } from "@/auth"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { fundModelCompatibilityError } from "@/agent/fund-policy"

export type CredentialMode = Auth.Info["type"] | "environment" | "configured" | "anonymous"

export function credentialMode(provider: Provider.Info, auth: Auth.Info | undefined): CredentialMode {
  if (auth) return auth.type
  if (provider.key) return "environment"
  if (typeof provider.options.apiKey === "string" && provider.options.apiKey.length > 0) return "configured"
  return "anonymous"
}

export function requiresToolCalls(agent: Agent.Info, tools?: Record<string, boolean>): boolean {
  if (tools && Object.values(tools).some(Boolean)) return true
  return agent.permission.some((rule) => rule.action !== "deny" && !["question", "doom_loop"].includes(rule.permission))
}

export function compatibilityError(input: {
  agent: Agent.Info
  model: Provider.Model
  tools?: Record<string, boolean>
}): string | undefined {
  const fundModelError = fundModelCompatibilityError({
    agent: input.agent.name,
    providerID: input.model.providerID,
    modelID: input.model.id,
  })
  if (fundModelError) return fundModelError
  if (requiresToolCalls(input.agent, input.tools) && !input.model.capabilities.toolcall) {
    return `Model ${input.model.providerID}/${input.model.id} does not support tool calls required by agent "${input.agent.name}". Choose a tool-capable model or a non-tool agent.`
  }
  return undefined
}

export * as ProviderPreflight from "./provider-preflight"
