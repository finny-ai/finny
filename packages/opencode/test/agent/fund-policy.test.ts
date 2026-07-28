import { describe, expect, test } from "bun:test"
import {
  FUND_MANAGER_AGENT,
  FUND_RUNTIME_MODEL,
  FUND_SPECIALIST_AGENTS,
  deprecatedSamplingOptionPaths,
  fundAgentConfigError,
  fundDelegationError,
  fundModelCompatibilityError,
  sanitizeFundModelRequestParams,
} from "../../src/agent/fund-policy"

describe("fund runtime policy", () => {
  test("defines the exact eight advisory specialist roles", () => {
    expect(FUND_SPECIALIST_AGENTS).toEqual([
      "fund_strategy_researcher",
      "fund_regime_analyst",
      "fund_fill_auditor",
      "fund_risk_analyst",
      "fund_code_change_agent",
      "fund_independent_validator",
      "fund_deployment_adviser",
      "fund_risk_sentinel",
    ])
  })

  test("locks every fund role to google/gemini-3.6-flash", () => {
    for (const agent of [FUND_MANAGER_AGENT, ...FUND_SPECIALIST_AGENTS]) {
      expect(
        fundModelCompatibilityError({
          agent,
          providerID: FUND_RUNTIME_MODEL.providerID,
          modelID: FUND_RUNTIME_MODEL.modelID,
        }),
      ).toBeUndefined()
      expect(
        fundModelCompatibilityError({
          agent,
          providerID: "google",
          modelID: "gemini-3.5-flash",
        }),
      ).toContain("locked to google/gemini-3.6-flash")
      expect(
        fundModelCompatibilityError({
          agent,
          providerID: "openrouter",
          modelID: "gemini-3.6-flash",
        }),
      ).toContain("locked to google/gemini-3.6-flash")
    }
    expect(
      fundModelCompatibilityError({
        agent: "finny",
        providerID: "test",
        modelID: "model",
      }),
    ).toBeUndefined()
  })

  test("rejects deprecated sampling configuration for fund roles", () => {
    expect(
      fundAgentConfigError({
        agent: FUND_MANAGER_AGENT,
        temperature: 0.2,
      }),
    ).toContain("temperature")
    expect(
      fundAgentConfigError({
        agent: "fund_risk_analyst",
        options: {
          google: {
            top_p: 0.8,
            nested: { topK: 40 },
          },
        },
      }),
    ).toContain("options.google.top_p")
    expect(
      fundAgentConfigError({
        agent: FUND_MANAGER_AGENT,
        model: "google/gemini-3.6-flash",
        options: { thinkingConfig: { thinkingLevel: "low" } },
      }),
    ).toBeUndefined()
    expect(
      fundAgentConfigError({
        agent: "finny",
        temperature: 0.2,
        options: { top_k: 10 },
      }),
    ).toBeUndefined()
  })

  test("rejects protected role disablement and canonical-name collisions", () => {
    expect(fundAgentConfigError({ agent: FUND_MANAGER_AGENT, disabled: true })).toContain("cannot be disabled")
    expect(fundAgentConfigError({ agent: "fund_risk_analyst", disabled: true })).toContain("cannot be disabled")
    expect(
      fundAgentConfigError({
        agent: "general",
        configuredName: FUND_MANAGER_AGENT,
      }),
    ).toContain("cannot rename")
    expect(
      fundAgentConfigError({
        agent: FUND_MANAGER_AGENT,
        configuredName: "general",
      }),
    ).toContain("cannot rename")
    expect(fundAgentConfigError({ agent: "general", configuredName: "reviewer" })).toBeUndefined()
  })

  test("strips deprecated sampling fields after provider and plugin transforms", () => {
    const input = {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      options: {
        top_p: 0.7,
        google: {
          topK: 20,
          thinkingConfig: { thinkingLevel: "low", temperature: 0.1 },
        },
        preserve: true,
      },
    }
    expect(deprecatedSamplingOptionPaths(input.options)).toEqual([
      "options.top_p",
      "options.google.topK",
      "options.google.thinkingConfig.temperature",
    ])
    expect(sanitizeFundModelRequestParams(FUND_RUNTIME_MODEL, input)).toEqual({
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      options: {
        google: { thinkingConfig: { thinkingLevel: "low" } },
        preserve: true,
      },
    })
    expect(sanitizeFundModelRequestParams({ providerID: "google", modelID: "gemini-3.5-flash" }, input)).toBe(input)
  })

  test("only Fund Manager may launch fund specialists and specialists cannot nest", () => {
    for (const specialist of FUND_SPECIALIST_AGENTS) {
      expect(fundDelegationError(FUND_MANAGER_AGENT, specialist)).toBeUndefined()
      expect(fundDelegationError("finny", specialist)).toContain("only by")
      expect(fundDelegationError(specialist, "general")).toContain("cannot delegate")
      expect(fundDelegationError(specialist, FUND_SPECIALIST_AGENTS[0])).toContain("cannot delegate")
    }
    expect(fundDelegationError(FUND_MANAGER_AGENT, "general")).toContain("only to registered fund specialists")
    expect(fundDelegationError("finny", "data_extractor")).toBeUndefined()
  })
})
