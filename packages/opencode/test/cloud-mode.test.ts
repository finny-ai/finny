import { describe, expect, test } from "bun:test"
import { finnyCloudEnabled } from "../src/cloud-mode"

describe("FINNY_CLOUD", () => {
  test("defaults to disabled", () => {
    expect(finnyCloudEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })

  test("enables cloud mode for explicit true values", () => {
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      expect(finnyCloudEnabled({ FINNY_CLOUD: value } as NodeJS.ProcessEnv)).toBe(true)
    }
  })

  test("keeps cloud mode disabled for other values", () => {
    for (const value of ["false", "0", "no", "off", ""]) {
      expect(finnyCloudEnabled({ FINNY_CLOUD: value } as NodeJS.ProcessEnv)).toBe(false)
    }
  })
})
