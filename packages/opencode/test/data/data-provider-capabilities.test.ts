import { describe, expect, test } from "bun:test"
import {
  discoverDataProviderCapabilities,
  renderDataProviderCapabilities,
} from "../../src/data/data-provider-capabilities"

describe("Data Agent provider capabilities", () => {
  test("advertises only installed, credential-compatible, request-compatible providers", () => {
    const capabilities = discoverDataProviderCapabilities({
      request: { assetClass: "equity", interval: "1d", start: "2018-01-02", end: "2025-12-31" },
      availableSkillIDs: new Set([
        "finny-provider-alpaca",
        "finny-provider-polygon",
        "finny-provider-yfinance",
        "finny-provider-binance",
      ]),
      credentialEnv: { ALPACA_API_KEY_ID: "configured", ALPACA_API_SECRET_KEY: "configured" },
    })

    expect(capabilities.map((capability) => capability.id)).toEqual(["alpaca", "yfinance"])
    expect(renderDataProviderCapabilities(capabilities).join("\n")).not.toContain("finny-provider-polygon")
    expect(renderDataProviderCapabilities(capabilities).join("\n")).not.toContain("finny-provider-binance")
  })

  test("does not advertise unavailable skills or known-incompatible public windows", () => {
    const capabilities = discoverDataProviderCapabilities({
      request: { assetClass: "equity", interval: "5min", start: "2026-01-01", end: "2026-04-15" },
      availableSkillIDs: new Set(["finny-provider-yfinance", "unrelated-skill"]),
      credentialEnv: {},
    })

    expect(capabilities).toEqual([])
    expect(renderDataProviderCapabilities(capabilities)).toEqual([
      "- provider_capabilities: NONE (return a typed provider blocker)",
    ])
  })

  test("advertises Binance only for supported crypto intervals", () => {
    const capabilities = discoverDataProviderCapabilities({
      request: { assetClass: "crypto", interval: "4h", start: "2026-01-01", end: "2026-02-01" },
      availableSkillIDs: new Set(["finny-provider-binance", "finny-provider-yfinance"]),
      credentialEnv: {},
    })

    expect(capabilities.map((capability) => capability.id)).toEqual(["binance"])
    expect(capabilities[0]?.skillID).toBe("finny-provider-binance")
  })

  test("treats shell-plugin credentialEnv markers as configured credentials", () => {
    // shell.env plugins merge into the same credentialEnv map as process/.env.
    const capabilities = discoverDataProviderCapabilities({
      request: { assetClass: "equity", interval: "1d", start: "2024-01-01", end: "2024-06-01" },
      availableSkillIDs: new Set(["finny-provider-polygon", "finny-provider-yfinance"]),
      credentialEnv: { POLYGON_API_KEY: "configured-from-shell-env-plugin" },
    })

    expect(capabilities.map((capability) => capability.id)).toEqual(["polygon", "yfinance"])
  })

  test("advertises only the native provider matching the exact regional ticker", () => {
    const skills = new Set([
      "finny-provider-zerodha",
      "finny-provider-saxo",
      "finny-provider-questrade",
      "finny-provider-futu",
      "finny-provider-yfinance",
    ])
    const capabilities = discoverDataProviderCapabilities({
      request: { symbol: "SHOP.TO", assetClass: "equity", interval: "1d" },
      availableSkillIDs: skills,
      credentialEnv: {
        QUESTRADE_ACCESS_TOKEN: "configured",
        QUESTRADE_API_SERVER: "https://api01.iq.questrade.com/",
        KITE_API_KEY: "configured",
        KITE_ACCESS_TOKEN: "configured",
      },
    })
    expect(capabilities.map((capability) => capability.id)).toEqual(["questrade", "yfinance"])
    expect(capabilities[0]?.calendarPolicy).toBe("REGIONAL_PROVIDER_OBSERVED")
  })
})
