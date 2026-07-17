import { describe, expect, test } from "bun:test"
import { finnyCloudEnabled, finnyEnterpriseEnabled, finnyProductMode, finnyProductName } from "../src/cloud-mode"

describe("Finny product env flags", () => {
  test("defaults to disabled", () => {
    expect(finnyCloudEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(finnyEnterpriseEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(finnyProductMode({} as NodeJS.ProcessEnv)).toBe("default")
    expect(finnyProductName({} as NodeJS.ProcessEnv)).toBe("Finny")
  })

  test("enables cloud mode for explicit true values", () => {
    for (const value of ["true", "TRUE", "ture", "1", "yes", "on"]) {
      expect(finnyCloudEnabled({ FINNY_CLOUD: value } as NodeJS.ProcessEnv)).toBe(true)
    }
  })

  test("enables enterprise mode for explicit true values", () => {
    for (const value of ["true", "TRUE", "ture", "1", "yes", "on"]) {
      expect(finnyEnterpriseEnabled({ FINNY_ENTERPRISE: value } as NodeJS.ProcessEnv)).toBe(true)
    }
  })

  test("keeps cloud mode disabled for other values", () => {
    for (const value of ["false", "0", "no", "off", ""]) {
      expect(finnyCloudEnabled({ FINNY_CLOUD: value } as NodeJS.ProcessEnv)).toBe(false)
    }
  })

  test("keeps enterprise mode disabled for other values", () => {
    for (const value of ["false", "0", "no", "off", ""]) {
      expect(finnyEnterpriseEnabled({ FINNY_ENTERPRISE: value } as NodeJS.ProcessEnv)).toBe(false)
    }
  })

  test("resolves product mode and display name", () => {
    expect(finnyProductMode({ FINNY_CLOUD: "true" } as NodeJS.ProcessEnv)).toBe("cloud")
    expect(finnyProductName({ FINNY_CLOUD: "true" } as NodeJS.ProcessEnv)).toBe("Finny Cloud")
    expect(finnyProductMode({ FINNY_ENTERPRISE: "true" } as NodeJS.ProcessEnv)).toBe("enterprise")
    expect(finnyProductName({ FINNY_ENTERPRISE: "true" } as NodeJS.ProcessEnv)).toBe("Finny Enterprise")
  })

  test("enterprise mode takes precedence when both flags are enabled", () => {
    const env = { FINNY_CLOUD: "true", FINNY_ENTERPRISE: "true" } as NodeJS.ProcessEnv

    expect(finnyProductMode(env)).toBe("enterprise")
    expect(finnyProductName(env)).toBe("Finny Enterprise")
  })
})
