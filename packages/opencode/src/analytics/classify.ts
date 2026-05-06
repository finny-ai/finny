// Built-in identifier allowlists for telemetry. Anything not on these lists
// is bucketed as "custom" so user-defined plugin/agent/command names never
// reach analytics — preserves the existing privacy guarantees codified in
// the comments at every track() callsite.

const BUILTIN_PROVIDERS = new Set<string>([
  "anthropic",
  "openai",
  "google",
  "github-copilot",
  "openrouter",
  "opencode",
  "ollama",
  "lmstudio",
  "azure",
  "bedrock",
  "vertex",
  "mistral",
  "cohere",
  "deepseek",
  "xai",
  "groq",
  "together",
  "fireworks",
  "perplexity",
])

// Native Finny + upstream OpenCode agents. Anything else is a user-defined
// agent from config.
const BUILTIN_AGENTS = new Set<string>(["build", "research", "chat", "general", "plan", "review"])

// Default slash commands shipped with the binary. User-defined commands
// (from `cfg.command` in config) and MCP/skill commands are not on the list.
const BUILTIN_COMMANDS = new Set<string>(["init", "review"])

// Stable error class names from the discriminated union in message-v2.ts.
const BUILTIN_ERRORS = new Set<string>([
  "APIError",
  "AbortedError",
  "MessageAbortedError",
  "OutputLengthError",
  "ContextOverflowError",
  "AuthError",
  "StructuredOutputError",
  "Unknown",
])

export namespace Classify {
  export function provider(id: string | undefined | null): string {
    if (!id) return "unknown"
    return BUILTIN_PROVIDERS.has(id) ? id : "custom"
  }

  // Only record the model literal when the provider is known. Custom-provider
  // model strings are plugin-controlled and could leak that surface.
  export function model(providerId: string | undefined | null, modelId: string | undefined | null): string | undefined {
    if (!providerId || !modelId) return undefined
    if (!BUILTIN_PROVIDERS.has(providerId)) return undefined
    return modelId
  }

  export function agent(name: string | undefined | null): string {
    if (!name) return "unknown"
    return BUILTIN_AGENTS.has(name) ? name : "custom"
  }

  export function command(name: string | undefined | null): string {
    if (!name) return "unknown"
    return BUILTIN_COMMANDS.has(name) ? name : "custom"
  }

  export function error(name: string | undefined | null): string {
    if (!name) return "unknown"
    return BUILTIN_ERRORS.has(name) ? name : "other"
  }
}
