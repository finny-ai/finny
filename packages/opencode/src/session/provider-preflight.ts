import type { Auth } from "@/auth"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { fundModelCompatibilityError, isFundRuntimeAgent } from "@/agent/fund-policy"

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
  provider?: Provider.Info
  tools?: Record<string, boolean>
}): string | undefined {
  const fundModelError = fundModelCompatibilityError({
    agent: input.agent.name,
    providerID: input.model.providerID,
    modelID: input.model.id,
  })
  if (fundModelError) return fundModelError
  if (isFundRuntimeAgent(input.agent.name)) {
    const provider = input.provider
    const endpoint = input.model.api?.url?.replace(/\/+$/, "")
    // models.dev represents the built-in SDK endpoint as an empty URL. The
    // Google SDK resolves that value to its own fixed default; provider-level
    // endpoint/fetch overrides remain forbidden below.
    const officialEndpoint = endpoint === "" || endpoint === "https://generativelanguage.googleapis.com"
    if (
      !provider ||
      !["api", "env"].includes(provider.source) ||
      provider.id !== "google" ||
      provider.options.baseURL !== undefined ||
      provider.options.fetch !== undefined ||
      input.model.api?.npm !== "@ai-sdk/google" ||
      input.model.api?.id !== "gemini-3.6-flash" ||
      !officialEndpoint
    ) {
      return (
        `Agent "${input.agent.name}" requires the built-in @ai-sdk/google transport for ` +
        "https://generativelanguage.googleapis.com with no configured endpoint or fetch override."
      )
    }
  }
  if (requiresToolCalls(input.agent, input.tools) && !input.model.capabilities.toolcall) {
    return `Model ${input.model.providerID}/${input.model.id} does not support tool calls required by agent "${input.agent.name}". Choose a tool-capable model or a non-tool agent.`
  }
  return undefined
}

export * as ProviderPreflight from "./provider-preflight"
