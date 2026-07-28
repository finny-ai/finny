import { describe, expect, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import type { Auth } from "../../src/auth"
import type { Provider } from "../../src/provider/provider"
import { ProviderPreflight } from "../../src/session/provider-preflight"

const agent = (permission: Agent.Info["permission"], name = "build"): Agent.Info =>
  ({ name, mode: "primary", permission, options: {} }) as Agent.Info

const model = (toolcall: boolean, providerID = "provider", id = "model"): Provider.Model =>
  ({
    id,
    providerID,
    capabilities: { toolcall },
  }) as Provider.Model

const provider = (input: Partial<Provider.Info> = {}): Provider.Info =>
  ({
    id: "provider",
    source: "api",
    key: undefined,
    options: {},
    models: {},
    name: "Provider",
    ...input,
  }) as Provider.Info

describe("provider preflight", () => {
  test("reports stored credential modes before environment and config fallbacks", () => {
    expect(ProviderPreflight.credentialMode(provider(), { type: "oauth" } as Auth.Info)).toBe("oauth")
    expect(ProviderPreflight.credentialMode(provider({ key: "secret" }), undefined)).toBe("environment")
    expect(ProviderPreflight.credentialMode(provider({ options: { apiKey: "secret" } }), undefined)).toBe("configured")
    expect(ProviderPreflight.credentialMode(provider(), undefined)).toBe("anonymous")
  })

  test("rejects a non-tool model for a tool-enabled primary agent", () => {
    const error = ProviderPreflight.compatibilityError({
      agent: agent([{ permission: "bash", pattern: "*", action: "allow" }]),
      model: model(false),
    })
    expect(error).toContain("does not support tool calls")
    expect(error).toContain('agent "build"')
  })

  test("accepts non-tool models when the route has no enabled tools", () => {
    expect(
      ProviderPreflight.compatibilityError({
        agent: agent([{ permission: "*", pattern: "*", action: "deny" }]),
        model: model(false),
      }),
    ).toBeUndefined()
  })

  test("fund roles fail closed unless the exact Google Gemini model is selected", () => {
    const manager = agent([{ permission: "*", pattern: "*", action: "deny" }], "fund_manager")
    expect(
      ProviderPreflight.compatibilityError({
        agent: manager,
        model: model(true, "google", "gemini-3.6-flash"),
      }),
    ).toBeUndefined()
    expect(
      ProviderPreflight.compatibilityError({
        agent: manager,
        model: model(true, "google", "gemini-3.5-flash"),
      }),
    ).toContain("locked to google/gemini-3.6-flash")
    expect(
      ProviderPreflight.compatibilityError({
        agent: manager,
        model: model(true, "openrouter", "gemini-3.6-flash"),
      }),
    ).toContain("locked to google/gemini-3.6-flash")
  })
})
